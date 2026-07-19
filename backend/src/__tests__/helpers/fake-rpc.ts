/**
 * Shared fake-RPC harness for readSnapshot tests.
 *
 * Lifted out of read-snapshot.test.ts so the batching tests can drive the SAME
 * fixture data through both the batched and unbatched paths. That shared fixture
 * is what makes equivalence assertions meaningful: if the two paths had their own
 * canned returns, "batched agrees with unbatched" would only prove the two
 * fixtures agree.
 */
import { beforeAll, beforeEach, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { decodeFunctionData, encodeAbiParameters, getAddress, type Address } from "viem";
import type { RpcClient, ReadSnapshotDeps } from "../../services/lz-config.js";
import { _resetChainRegistryCache } from "../../services/chain-registry.js";
import type { ChainRef } from "../../types.js";

// ── Fixtures / ABI-shaped canned returns ─────────────────────────────────────
export const ENDPOINT = "0x1a44076050125825900e736c501f859c50fE728c" as Address;
export const OFT = "0x" + "12".repeat(20);
export const OWNER = "0x" + "a1".repeat(20);
export const SENDLIB = "0x" + "5e".repeat(20);
export const RECVLIB = "0x" + "5c".repeat(20);
export const PEER = "0x" + "ab".repeat(20);
export const ETH_EID = 30101;
export const MANTLE_EID = 30181;

/** 4-byte selectors (must mirror SEL in lz-config.ts). */
export const SEL = {
  getSendLibrary: "0xb96a277f",
  isDefaultSendLibrary: "0xdc93c8a2",
  getReceiveLibrary: "0x402f8468",
  getConfig: "0x2b3197b9",
  peers: "0xbb0b6a53",
  owner: "0x8da5cb5b",
  getThreshold: "0xe75235b8",
  enforcedOptions: "0x5535d461",
};

export const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const boolWord = (b: boolean) => (b ? "1" : "0").padStart(64, "0");
export const peersRet = (addr: string) => "0x" + word(addr);
export const addrWord = (addr: string) => "0x" + word(addr);
const addrBoolRet = (addr: string, b: boolean) => "0x" + word(addr) + boolWord(b);
const enforcedEmpty = "0x" + "0".repeat(128);

/** A peers() word of all zeroes — the on-chain shape of "no peer for this eid".
 *  The COMMON case on a real sweep: ~100 of the ~120 known EIDs answer this. */
export const ZERO_PEER = "0x" + "0".repeat(64);

// ── Reverts that carry return data ───────────────────────────────────────────
/**
 * A handler return can be marked as a REVERT rather than a successful read.
 *
 * The distinction matters because a reverting sub-call is not the same as one
 * returning nothing: real chains revert with a payload (`Error(string)` from a
 * `require`, or a custom error), and Multicall3 reports that as
 * `{success: false, returnData: <non-empty bytes>}`. A harness that can only
 * emit `{success: false, returnData: "0x"}` cannot tell whether a decoder reads
 * the `success` flag or merely checks for empty bytes — so the revert payload
 * being mistaken for valid return data (and its last 20 bytes minted into an
 * address) is invisible to it.
 *
 * `revertWith` is honoured on BOTH paths, so a fixture stays truthful whichever
 * one the chain takes: multicallHandler maps it to a failed aggregate3 row, and
 * makeFactory throws it, which is what viem does for a direct eth_call revert.
 */
const REVERT_MARK = "revert!";

/** Mark a handler's return as a revert carrying `returnData` (may be "0x"). */
export const revertWith = (returnData: string) => REVERT_MARK + returnData;

/** The revert payload, or null if `r` is an ordinary successful return. */
export function asRevert(r: string): string | null {
  return r.startsWith(REVERT_MARK) ? r.slice(REVERT_MARK.length) : null;
}

/** Standard `Error(string)` revert payload — what `require(false, msg)` returns.
 *  Non-empty bytes on a FAILED call, which is the discriminating case. */
export function errorStringRevert(msg: string): string {
  return revertWith(
    "0x08c379a0" + encodeAbiParameters([{ type: "string" }], [msg]).slice(2),
  );
}

/** UlnConfig-shaped bytes decodable by decodeUlnConfig; requiredDVNCount is the
 *  only field we vary (word index 4 = byte offset 128). */
export function buildUln(requiredDVNCount: number): string {
  const words = new Array(20).fill("0".repeat(64));
  words[4] = word(requiredDVNCount.toString(16));
  return "0x" + words.join("");
}
export const ulnZero = buildUln(0);
export const ulnDiff = buildUln(1);

export const ZERO_ULN = {
  confirmations: 0,
  requiredDVNCount: 0,
  requiredDVNs: [],
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  optionalDVNs: [],
};

export type Handler = (to: Address, data: string) => string;

/** A handler that answers every selector with valid data (given a getConfig uln). */
export function fullHandler(uln = ulnZero, ownerCode = "0xabcd"): { handler: Handler; ownerCode: string } {
  const handler: Handler = (_to, data) => {
    switch (data.slice(0, 10)) {
      case SEL.peers: return peersRet(PEER);
      case SEL.getSendLibrary: return addrWord(SENDLIB);
      // 0x-prefixed, like every real RPC return. Without the prefix the plain
      // path still read it as `false` (BigInt of a zero-word), while the batched
      // path handed the unprefixed string to viem's bytes encoder and got a
      // NON-zero payload back — so the same fixture produced `false` unbatched
      // and `true` batched. A harness that answers in a shape no chain emits
      // cannot testify about equivalence.
      case SEL.isDefaultSendLibrary: return "0x" + boolWord(false);
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

/** Every read fails → forces the fallback chain. */
export const failHandler: Handler = () => "0x";

export interface FakeSpec { handler: Handler; ownerCode?: string }

/** Build an injectable makeClient over a url→spec map, logging every call. */
export function makeFactory(specs: Record<string, FakeSpec>, log: string[]) {
  return (url: string): RpcClient => ({
    async call({ to, data }) {
      log.push(`${url}|${data.slice(0, 10)}`);
      const spec = specs[url];
      if (!spec) throw new Error("no fake for url " + url);
      const out = spec.handler(to, data);
      // A revert is an error on the per-call path — viem throws, it does not
      // hand back the revert payload as if it were return data.
      if (asRevert(out) !== null) throw new Error("execution reverted");
      return { data: out };
    },
    async getBytecode() {
      return specs[url]?.ownerCode ?? "0x";
    },
    async getStorageAt() {
      return "0x"; // no proxy admin slot
    },
  });
}

/** Multicall3 aggregate3 selector. */
export const AGG3_SEL = "0x82ad56cb";

/** Wrap a plain selector-dispatch handler so it also answers Multicall3
 *  aggregate3, routing each sub-call back through the inner handler.
 *  Lets the SAME fixture data serve the batched and unbatched paths — which is
 *  what makes equivalence assertions meaningful. */
export function multicallHandler(inner: Handler): Handler {
  const abi = [
    {
      name: "aggregate3", type: "function", stateMutability: "payable",
      inputs: [{
        name: "calls", type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      }],
      outputs: [],
    },
  ] as const;

  return (to, data) => {
    if (data.slice(0, 10) !== AGG3_SEL) return inner(to, data);
    const { args } = decodeFunctionData({ abi, data: data as `0x${string}` });
    const calls = args![0] as readonly { target: Address; callData: string }[];
    const rows = calls.map((c) => {
      const r = inner(c.target, c.callData);
      // An explicit revert (see revertWith / errorStringRevert) keeps its
      // payload: success=false WITH non-empty returnData, which is what a real
      // chain returns for `require(false, msg)` and the only shape that can
      // tell a success-flag check apart from an empty-bytes check.
      const reverted = asRevert(r);
      if (reverted !== null) {
        return { success: false, returnData: reverted as `0x${string}` };
      }
      // Empty return == the sub-call produced nothing; model it as a revert,
      // which is how a real Multicall3 reports a failing sub-call.
      return r && r !== "0x"
        ? { success: true, returnData: r as `0x${string}` }
        : { success: false, returnData: "0x" as `0x${string}` };
    });
    return encodeAbiParameters(
      [{
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      }],
      [rows],
    );
  };
}

export const rpc = (url: string, provider: string) => ({ url, provider });

export function chainRef(rpcs: { url: string; provider: string }[], over: Partial<ChainRef> = {}): ChainRef {
  return {
    chainKey: "mantle",
    eid: MANTLE_EID,
    chainId: 5000,
    eligible: true,
    etherscanFree: false,
    multicall3: false,
    rpcs,
    ...over,
  };
}

export const eidMapDep = async () => ({ [ETH_EID]: { chainKey: "ethereum", endpoint: ENDPOINT } });

/**
 * A corridor set large enough to span several MULTICALL_CHUNK_SIZE (50) chunks.
 * The single-EID default map makes every batch size-1, which cannot detect a
 * chunking bug or a result/EID misalignment — the ordering guarantee is the
 * load-bearing part of resilientBatch's contract, so it needs a fixture that
 * can actually violate it.
 */
export const MANY_EIDS = Array.from({ length: 120 }, (_, i) => 40_000 + i);

export const manyEidMap = async () =>
  Object.fromEntries(
    MANY_EIDS.map((e) => [e, { chainKey: `chain-${e}`, endpoint: ENDPOINT }]),
  );

/** The peer address this EID must map to — distinct per EID, so a misaligned
 *  batch result lands a neighbour's peer and the assertion catches it. */
export const peerForEid = (eid: number) =>
  getAddress(("0x" + eid.toString(16).padStart(40, "0")) as Address);

/**
 * Wrap a handler so peers(eid) returns a peer unique to that EID.
 *
 * `zeroFor` makes those EIDs answer an all-zero word instead — the on-chain
 * "no peer here" reply, and the majority answer on a real full-EID sweep.
 * `malformedFor` makes them answer an undecodable word, which is what a
 * misbehaving RPC hands back; it must cost that corridor and nothing else.
 */
export function perEidPeers(
  inner: Handler,
  opts: { zeroFor?: Iterable<number>; malformedFor?: Iterable<number> } = {},
): Handler {
  const zero = new Set(opts.zeroFor ?? []);
  const bad = new Set(opts.malformedFor ?? []);
  return (to, data) => {
    if (data.slice(0, 10) !== SEL.peers) return inner(to, data);
    const eid = parseInt(data.slice(10), 16);
    if (bad.has(eid)) return MALFORMED_PEER;
    if (zero.has(eid)) return ZERO_PEER;
    return "0x" + word(eid.toString(16).padStart(40, "0"));
  };
}

/** Not hex — BigInt() throws SyntaxError on it. Some public RPCs really do
 *  return junk like this, and it reaches the decoder verbatim on the per-call
 *  path (no viem ABI decode in between). */
export const MALFORMED_PEER = "0xZZZZ";
export const dvnMetaDep = async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() });

export function deps(extra: Partial<ReadSnapshotDeps>): ReadSnapshotDeps {
  return { loadEidMap: eidMapDep, loadDvnMeta: dvnMetaDep, ...extra };
}

/**
 * Point the destination-RPC registry lookup at an empty registry so the dest-side
 * receive read is deterministically skipped (receiveUln null) — keeps snapshot
 * fixtures hermetic and independent of the committed chain-registry.json.
 *
 * Call at the top level of a test file; it registers its own beforeAll/afterAll.
 *
 * The env var is re-asserted in beforeEach, not just beforeAll. process.env is
 * shared by every test file that lands in the same vitest worker, so a sibling
 * file's afterAll can delete CHAIN_REGISTRY_PATH out from under a file that is
 * still running. That drops readSnapshot onto the real committed registry and a
 * live RPC URL, and the test hangs until the 5s timeout instead of failing
 * honestly. Re-asserting per test makes the hermetic setup order-independent.
 */
export function installHermeticChainRegistry(): void {
  let regDir: string;
  let regFile: string;
  const savedRegPath = process.env.CHAIN_REGISTRY_PATH;

  beforeAll(() => {
    regDir = mkdtempSync(join(tmpdir(), "lzreg-"));
    regFile = join(regDir, "reg.json");
    writeFileSync(regFile, JSON.stringify({ generatedAt: "x", source: "test", chains: {} }));
    process.env.CHAIN_REGISTRY_PATH = regFile;
    _resetChainRegistryCache();
  });

  beforeEach(() => {
    if (process.env.CHAIN_REGISTRY_PATH !== regFile) {
      process.env.CHAIN_REGISTRY_PATH = regFile;
      _resetChainRegistryCache();
    }
  });
  afterAll(() => {
    rmSync(regDir, { recursive: true, force: true });
    if (savedRegPath === undefined) delete process.env.CHAIN_REGISTRY_PATH;
    else process.env.CHAIN_REGISTRY_PATH = savedRegPath;
    _resetChainRegistryCache();
  });
}
