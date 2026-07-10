import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getAddress, type Address } from "viem";
import { readSnapshot, _resetCorridorCache, type RpcClient, type ReadSnapshotDeps } from "../services/lz-config.js";
import { _resetChainRegistryCache } from "../services/chain-registry.js";
import type { ChainRef } from "../types.js";

// ── Fixtures / ABI-shaped canned returns ─────────────────────────────────────
const ENDPOINT = "0x1a44076050125825900e736c501f859c50fE728c" as Address;
const OFT = "0x" + "12".repeat(20);
const OWNER = "0x" + "a1".repeat(20);
const SENDLIB = "0x" + "5e".repeat(20);
const RECVLIB = "0x" + "5c".repeat(20);
const PEER = "0x" + "ab".repeat(20);
const ETH_EID = 30101;
const MANTLE_EID = 30181;

// 4-byte selectors (must mirror SEL in lz-config.ts).
const SEL = {
  getSendLibrary: "0xb96a277f",
  isDefaultSendLibrary: "0xdc93c8a2",
  getReceiveLibrary: "0x402f8468",
  getConfig: "0x2b3197b9",
  peers: "0xbb0b6a53",
  owner: "0x8da5cb5b",
  getThreshold: "0xe75235b8",
  enforcedOptions: "0x5535d461",
};

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const boolWord = (b: boolean) => (b ? "1" : "0").padStart(64, "0");
const peersRet = (addr: string) => "0x" + word(addr);
const addrWord = (addr: string) => "0x" + word(addr);
const addrBoolRet = (addr: string, b: boolean) => "0x" + word(addr) + boolWord(b);
const enforcedEmpty = "0x" + "0".repeat(128);

/** UlnConfig-shaped bytes decodable by decodeUlnConfig; requiredDVNCount is the
 *  only field we vary (word index 4 = byte offset 128). */
function buildUln(requiredDVNCount: number): string {
  const words = new Array(20).fill("0".repeat(64));
  words[4] = word(requiredDVNCount.toString(16));
  return "0x" + words.join("");
}
const ulnZero = buildUln(0);
const ulnDiff = buildUln(1);

const ZERO_ULN = {
  confirmations: 0,
  requiredDVNCount: 0,
  requiredDVNs: [],
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  optionalDVNs: [],
};

type Handler = (to: Address, data: string) => string;

/** A handler that answers every selector with valid data (given a getConfig uln). */
function fullHandler(uln = ulnZero, ownerCode = "0xabcd"): { handler: Handler; ownerCode: string } {
  const handler: Handler = (_to, data) => {
    switch (data.slice(0, 10)) {
      case SEL.peers: return peersRet(PEER);
      case SEL.getSendLibrary: return addrWord(SENDLIB);
      case SEL.isDefaultSendLibrary: return boolWord(false);
      case SEL.getReceiveLibrary: return addrBoolRet(RECVLIB, false);
      case SEL.getConfig: return uln;
      case SEL.enforcedOptions: return enforcedEmpty;
      case SEL.owner: return addrWord(OWNER);
      case SEL.getThreshold: return "0x";
      default: return "0x";
    }
  };
  return { handler, ownerCode };
}
const failHandler: Handler = () => "0x"; // every read fails → forces fallback

interface FakeSpec { handler: Handler; ownerCode?: string }

/** Build an injectable makeClient over a url→spec map, logging every call. */
function makeFactory(specs: Record<string, FakeSpec>, log: string[]) {
  return (url: string): RpcClient => ({
    async call({ to, data }) {
      log.push(`${url}|${data.slice(0, 10)}`);
      const spec = specs[url];
      if (!spec) throw new Error("no fake for url " + url);
      return { data: spec.handler(to, data) };
    },
    async getBytecode() {
      return specs[url]?.ownerCode ?? "0x";
    },
    async getStorageAt() {
      return "0x"; // no proxy admin slot
    },
  });
}

function chainRef(rpcs: { url: string; provider: string }[], over: Partial<ChainRef> = {}): ChainRef {
  return {
    chainKey: "mantle",
    eid: MANTLE_EID,
    chainId: 5000,
    eligible: true,
    etherscanFree: false,
    rpcs,
    ...over,
  };
}

const eidMapDep = async () => ({ [ETH_EID]: { chainKey: "ethereum", endpoint: ENDPOINT } });
const dvnMetaDep = async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() });
function deps(extra: Partial<ReadSnapshotDeps>): ReadSnapshotDeps {
  return { loadEidMap: eidMapDep, loadDvnMeta: dvnMetaDep, ...extra };
}

// Point the destination-RPC registry lookup at an empty registry so the dest-side
// receive read is deterministically skipped (receiveUln null) — keeps snapshot
// fixtures hermetic and independent of the committed chain-registry.json.
let regDir: string;
const savedRegPath = process.env.CHAIN_REGISTRY_PATH;

beforeAll(() => {
  regDir = mkdtempSync(join(tmpdir(), "lzreg-"));
  const f = join(regDir, "reg.json");
  writeFileSync(f, JSON.stringify({ generatedAt: "x", source: "test", chains: {} }));
  process.env.CHAIN_REGISTRY_PATH = f;
  _resetChainRegistryCache();
});
afterAll(() => {
  rmSync(regDir, { recursive: true, force: true });
  if (savedRegPath === undefined) delete process.env.CHAIN_REGISTRY_PATH;
  else process.env.CHAIN_REGISTRY_PATH = savedRegPath;
  _resetChainRegistryCache();
});
beforeEach(() => _resetCorridorCache());

describe("readSnapshot — registry-driven clients", () => {
  it("falls back through rpcs in order and cross-checks with a DIFFERENT provider", async () => {
    const log: string[] = [];
    const good = fullHandler();
    // p0 (official) fails everything → forces fallback; p1 (official, same provider)
    // serves reads; p2 (drpc, different provider) is the only valid cross-check source.
    const factory = makeFactory(
      {
        p0: { handler: failHandler },
        p1: { handler: good.handler, ownerCode: "0x" },
        p2: { handler: good.handler, ownerCode: "0x" },
      },
      log
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "official" },
      { url: "p2", provider: "drpc" },
    ]);
    const snap = await readSnapshot(OFT, chain, deps({ makeClient: factory }));

    // A route was read (via the fallback chain, since p0 fails).
    expect(snap.routes).toHaveLength(1);
    expect(snap.routes[0].peer).toBe(getAddress(PEER));
    expect(snap.routes[0].uln).toEqual(ZERO_ULN);

    // Primary is tried first; p1 is used as the working fallback.
    expect(log[0].startsWith("p0|")).toBe(true);
    expect(log.some((l) => l.startsWith("p1|"))).toBe(true);
    // Cross-check ran on p2 (different provider), never on same-provider p1.
    expect(log).toContain(`p2|${SEL.getConfig}`);
  });

  it("does NOT run the rpcConflict cross-check when every fallback shares the primary's provider", async () => {
    const log: string[] = [];
    // Primary serves valid reads; the only fallback is the SAME provider but would
    // report a conflicting config. Because there is no independent provider, the
    // cross-check must be skipped (not faked) → rpcConflict stays undefined.
    const factory = makeFactory(
      {
        p0: fullHandler(ulnZero),
        p1: { handler: fullHandler(ulnDiff).handler },
      },
      log
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "official" },
    ]);
    const snap = await readSnapshot(OFT, chain, deps({ makeClient: factory }));
    expect(snap.routes[0].rpcConflict).toBeUndefined();
    // The same-provider fallback was never consulted for a cross-check getConfig.
    expect(log).not.toContain(`p1|${SEL.getConfig}`);
  });

  it("flags rpcConflict when a different-provider secondary disagrees", async () => {
    const log: string[] = [];
    const factory = makeFactory(
      {
        p0: fullHandler(ulnZero),
        p1: { handler: fullHandler(ulnDiff).handler }, // drpc returns a different config
      },
      log
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "drpc" },
    ]);
    const snap = await readSnapshot(OFT, chain, deps({ makeClient: factory }));
    expect(snap.routes[0].rpcConflict).toBe(true);
  });

  it("produces a byte-identical Mantle snapshot for a fixed RPC set", async () => {
    const factory = makeFactory(
      { p0: fullHandler(ulnZero), p1: fullHandler(ulnZero) },
      []
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "drpc" },
    ]);
    const snap = await readSnapshot(OFT, chain, deps({ makeClient: factory }));
    const { capturedAt, ...rest } = snap;
    expect(typeof capturedAt).toBe("number");
    expect(rest).toEqual({
      oft: getAddress(OFT),
      chainId: 5000,
      owner: getAddress(OWNER),
      ownerIsContract: true,
      proxyAdmin: null,
      proxyAdminOwner: null,
      proxyAdminIsMultisig: null,
      proxyAdminOwnerIsContract: null,
      routes: [
        {
          eid: ETH_EID,
          chainName: "ethereum",
          chainKey: "ethereum",
          sendLibrary: getAddress(SENDLIB),
          sendLibIsDefault: false,
          receiveLibrary: getAddress(RECVLIB),
          receiveLibIsDefault: false,
          uln: ZERO_ULN,
          receiveUln: null,
          peer: getAddress(PEER),
          peerAddress: getAddress(PEER),
          hasEnforcedOptions: false,
          isActive: true,
        },
      ],
    });
  });
});

describe("readSnapshot — corridor cache", () => {
  it("skips discovery on a cache hit within TTL", async () => {
    const discover = vi.fn(async () => new Map<number, string>([[ETH_EID, peersRet(PEER)]]));
    const factory = makeFactory({ p0: fullHandler(), p1: fullHandler() }, []);
    const chain = chainRef(
      [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
      { etherscanFree: true }
    );
    const d = deps({ makeClient: factory, discoverPeers: discover });

    const first = await readSnapshot(OFT, chain, d);
    expect(first.routes).toHaveLength(1);
    expect(discover).toHaveBeenCalledTimes(1);

    const second = await readSnapshot(OFT, chain, d);
    expect(second.routes).toHaveLength(1);
    // Cache hit → discovery not re-run.
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("re-discovers after the corridor TTL expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-08T00:00:00Z"));
      const discover = vi.fn(async () => new Map<number, string>([[ETH_EID, peersRet(PEER)]]));
      const factory = makeFactory({ p0: fullHandler(), p1: fullHandler() }, []);
      const chain = chainRef(
        [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
        { etherscanFree: true }
      );
      const d = deps({ makeClient: factory, discoverPeers: discover });

      await readSnapshot(OFT, chain, d);
      expect(discover).toHaveBeenCalledTimes(1);

      // Advance past the default 60-min TTL.
      vi.setSystemTime(new Date(Date.now() + 60 * 60_000 + 1));
      await readSnapshot(OFT, chain, d);
      expect(discover).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
