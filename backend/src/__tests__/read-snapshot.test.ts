import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAddress } from "viem";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  ENDPOINT, OFT, OWNER, SENDLIB, RECVLIB, PEER, ETH_EID,
  SEL, peersRet, ulnZero, ulnDiff, ZERO_ULN,
  AGG3_SEL, multicallHandler, MANY_EIDS, manyEidMap, peerForEid, perEidPeers,
  fullHandler, failHandler, makeFactory, chainRef, deps,
  installHermeticChainRegistry,
} from "./helpers/fake-rpc.js";

installHermeticChainRegistry();

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
          // The stub client answers the config selectors but not quoteSend, so the
          // sendability probe cannot reach a verdict. UNKNOWN — never DORMANT — is the
          // correct read of "we failed to ask", and it caps nothing.
          sendability: "UNKNOWN",
        },
      ],
    });
  });
});

// These two tests do ~1.3-1.9s of real work each (measured identical before and
// after the batching change), which leaves little headroom under vitest's 5s
// default once a sibling test file runs in parallel. That combination produced a
// reproducible timeout, so both get an explicit generous budget. The budget is
// headroom, not an expectation: if either starts genuinely approaching it, that
// is a real regression and not a reason to raise the number again.
const CACHE_TEST_TIMEOUT = 30_000;

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
  }, CACHE_TEST_TIMEOUT);

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
  }, CACHE_TEST_TIMEOUT);
});

describe("corridor discovery — Multicall3 batching", () => {
  it("discovers corridors in batches when multicall3 is available", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    const chain = chainRef([{ url: "u1", provider: "p1" }], { multicall3: true });
    const factory = makeFactory({ u1: { handler: multicallHandler(handler) } }, log);

    await readSnapshot(OFT, chain, deps({ makeClient: factory }));

    const peersCalls = log.filter((l) => l.includes(SEL.peers)).length;
    const aggCalls = log.filter((l) => l.includes(AGG3_SEL)).length;
    expect(aggCalls).toBeGreaterThan(0);
    expect(peersCalls).toBe(0); // every peers() read went through the batch
  });

  it("EQUIVALENCE: the batched corridor set matches the unbatched one exactly", async () => {
    const { handler } = fullHandler();

    // Same fixture data, both paths — so any difference is the batching, not the fixture.
    _resetCorridorCache();
    const unbatched = await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: false }),
      deps({ makeClient: makeFactory({ u1: { handler } }, []) }),
    );

    // Cache would make the second read a no-op and prove nothing.
    _resetCorridorCache();
    const batched = await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
      deps({ makeClient: makeFactory({ u1: { handler: multicallHandler(handler) } }, []) }),
    );

    expect(batched.routes.map((r) => r.eid).sort()).toEqual(
      unbatched.routes.map((r) => r.eid).sort(),
    );
    expect(batched.routes.map((r) => r.peer).sort()).toEqual(
      unbatched.routes.map((r) => r.peer).sort(),
    );
    expect(unbatched.routes.length).toBeGreaterThan(0); // guard against vacuous equality
  });
});

describe("corridor discovery — batch ordering and chunking", () => {
  it("ORDERING: every eid keeps its OWN peer across a multi-chunk batch", async () => {
    // 120 corridors > MULTICALL_CHUNK_SIZE (50), so this spans 3 chunks. Each eid
    // resolves to a distinct peer, so any misalignment between a batch result and
    // its input index lands a neighbour's peer here.
    const { handler } = fullHandler();
    const snap = await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
      deps({
        makeClient: makeFactory(
          { u1: { handler: multicallHandler(perEidPeers(handler)) } },
          [],
        ),
        loadEidMap: manyEidMap,
      }),
    );

    expect(snap.routes.length).toBe(MANY_EIDS.length);
    for (const r of snap.routes) {
      expect(r.peerAddress).toBe(peerForEid(r.eid));
    }
  });

  it("chunks a large corridor sweep into multiple aggregate3 round-trips", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
      deps({
        makeClient: makeFactory(
          { u1: { handler: multicallHandler(perEidPeers(handler)) } },
          log,
        ),
        loadEidMap: manyEidMap,
      }),
    );
    const agg = log.filter((l) => l.includes(AGG3_SEL)).length;
    expect(agg).toBeGreaterThanOrEqual(3); // 120 calls / chunk 50
    expect(log.filter((l) => l.includes(SEL.peers)).length).toBe(0);
  });
});
