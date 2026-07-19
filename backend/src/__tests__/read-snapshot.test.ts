import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAddress } from "viem";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  ENDPOINT, OFT, OWNER, SENDLIB, RECVLIB, PEER, ETH_EID,
  SEL, peersRet, ulnZero, ulnDiff, ZERO_ULN,
  AGG3_SEL, multicallHandler, MANY_EIDS, manyEidMap, peerForEid, perEidPeers,
  fullHandler, failHandler, makeFactory, chainRef, deps, eidMapDep,
  installHermeticChainRegistry, revertWith, word, type Handler,
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

describe("send-side ULN — Multicall3 batching", () => {
  // The whole-snapshot equivalence assertion. Any behavioural difference between
  // the batched and unbatched read paths is a bug, not a tradeoff, so the check
  // is on the ENTIRE snapshot (minus the wall-clock stamp) rather than on the
  // handful of fields a given task happened to touch.
  //
  // Run over BOTH corridor fixtures. The single-EID map makes every wave-1 batch
  // 4 calls and every wave-2 batch 1 — too small to expose a chunk boundary or a
  // result/route misalignment. The 120-corridor map makes wave 1 480 calls (10
  // chunks) and wave 2 120 (3 chunks), with a distinct peer per EID, so a batch
  // result landing on a neighbouring route shows up as a wrong peer.
  //
  // `maxRatio` is per fixture because the saving is not uniform: a handful of
  // reads (decimals, owner, the sendability probe, the cross-check) are per-OFT
  // or deliberately unbatched, and at one corridor that fixed overhead dominates.
  // The saving is proportional to corridor count, which is the point.
  const fixtures: [string, () => Promise<Record<number, { chainKey: string; endpoint: `0x${string}` }>>, number][] = [
    ["single corridor", eidMapDep as any, 1],
    ["120 corridors", manyEidMap as any, 3],
  ];

  it.each(fixtures)(
    "EQUIVALENCE: identical snapshot with and without multicall (%s)",
    async (_name, loadEidMap, maxRatio) => {
      const { handler } = fullHandler();
      // An all-healthy fixture makes equivalence cheap: with every sub-call
      // succeeding, the two paths cannot disagree about what a FAILED read means,
      // and that is the only place they differ. So some corridors fail some reads.
      //
      // The revert payloads are deliberately WELL-FORMED for their decoder — a
      // 32-byte word that reads as a perfectly good library address, and a
      // bytes-encoding that reads as non-empty enforced options. That is the
      // hazard: on the batched path only the aggregate3 success flag says these
      // failed, and a decoder that skips it mints a send library out of a revert
      // (and then reads a wave-2 ULN against it) or asserts enforced options are
      // set on a route we could not read. Junk payloads would be rejected by the
      // decoders anyway and prove nothing.
      //
      // Only EIDs from the 120-corridor map are affected, so the single-corridor
      // case stays the all-healthy one.
      const addrShapedRevert = revertWith("0x" + word(("0x" + "de".repeat(20))));
      const bytesShapedRevert = revertWith(
        "0x" + word("20") + word("2") + "beef".padEnd(64, "0"),
      );
      const failing: Handler = (to, data) => {
        const sel = data.slice(0, 10);
        const eid =
          sel === SEL.enforcedOptions ? parseInt(data.slice(10, 74), 16)
          : sel === SEL.getSendLibrary ? parseInt(data.slice(74, 138), 16)
          : sel === SEL.getConfig ? parseInt(data.slice(138, 202), 16)
          : -1;
        if (eid >= 40_000) {
          if (sel === SEL.enforcedOptions && eid % 7 === 3) return bytesShapedRevert;
          if (sel === SEL.getSendLibrary && eid % 13 === 4) return addrShapedRevert;
          if (sel === SEL.getConfig && eid % 11 === 5) return "0x";
        }
        return handler(to, data);
      };
      const inner = perEidPeers(failing);

      const logPlain: string[] = [];
      _resetCorridorCache();
      const plain = await readSnapshot(
        OFT,
        chainRef([{ url: "u1", provider: "p1" }], { multicall3: false }),
        deps({ makeClient: makeFactory({ u1: { handler: inner } }, logPlain), loadEidMap }),
      );

      // Cache would make the second read skip discovery entirely and prove nothing.
      _resetCorridorCache();
      const logBatch: string[] = [];
      const batched = await readSnapshot(
        OFT,
        chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
        deps({
          makeClient: makeFactory({ u1: { handler: multicallHandler(inner) } }, logBatch),
          loadEidMap,
        }),
      );

      const { capturedAt: _a, ...batchedRest } = batched;
      const { capturedAt: _b, ...plainRest } = plain;
      expect(batchedRest).toEqual(plainRest);
      expect(plain.routes.length).toBeGreaterThan(0); // guard against vacuous equality
      if (plain.routes.length > 1) {
        // The failure fixture is doing its job — otherwise "the two paths agree"
        // would only mean "neither path had to decide what a failed read means".
        expect(plain.routes.filter((r) => r.hasEnforcedOptions === null).length).toBeGreaterThan(0);
        expect(plain.routes.filter((r) => r.sendLibrary === null).length).toBeGreaterThan(0);
        expect(plain.routes.filter((r) => r.uln === null).length).toBeGreaterThan(0);
      }
      // The point of the change: far fewer round trips for the same answer.
      expect(logBatch.length).toBeLessThan(logPlain.length / maxRatio);
    },
  );

  it("routes send-side reads through aggregate3, not one call per selector", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
      deps({
        makeClient: makeFactory({ u1: { handler: multicallHandler(perEidPeers(handler)) } }, log),
        loadEidMap: manyEidMap,
      }),
    );
    // Every send-side selector now arrives inside an aggregate3 payload. The
    // secondary cross-check getConfig is the one deliberate exception, and it
    // cannot appear here because this chain has a single RPC (no secondary).
    for (const sel of [SEL.getSendLibrary, SEL.isDefaultSendLibrary, SEL.getReceiveLibrary, SEL.getConfig, SEL.enforcedOptions]) {
      expect(log.filter((l) => l.endsWith("|" + sel))).toEqual([]);
    }
    expect(log.filter((l) => l.includes(AGG3_SEL)).length).toBeGreaterThan(0);
  });

  it("keeps the rpcConflict cross-check on the individual path, against the OTHER provider", async () => {
    // The cross-check exists to have a SECOND provider corroborate the primary's
    // ULN. Routed through resilientBatch it would go back to the primary client
    // and agree with itself by construction — the check would still "run", still
    // pass, and never flag a manipulated read again.
    const log: string[] = [];
    const snap = await readSnapshot(
      OFT,
      chainRef(
        [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
        { multicall3: true },
      ),
      deps({
        makeClient: makeFactory(
          {
            p0: { handler: multicallHandler(fullHandler(ulnZero).handler) },
            p1: { handler: multicallHandler(fullHandler(ulnDiff).handler) },
          },
          log,
        ),
      }),
    );
    expect(snap.routes[0].rpcConflict).toBe(true);
    // …and it went out as a bare getConfig on p1, never as a batch.
    expect(log).toContain(`p1|${SEL.getConfig}`);
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
