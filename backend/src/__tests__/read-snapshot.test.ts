import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAddress } from "viem";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  ENDPOINT, OFT, OWNER, SENDLIB, RECVLIB, PEER, ETH_EID,
  SEL, peersRet, ulnZero, ulnDiff, ZERO_ULN,
  AGG3_SEL, multicallHandler, MANY_EIDS, manyEidMap, peerForEid, perEidPeers,
  fullHandler, failHandler, makeFactory, chainRef, deps, eidMapDep,
  installHermeticChainRegistry, revertWith, word, buildUln, type Handler,
  setChainRegistryChains, errorStringRevert,
} from "./helpers/fake-rpc.js";
import type { ChainRef, RouteSnapshot } from "../types.js";

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

  it.each([true, false])(
    "ORDERING: every eid keeps its OWN wave-2 ULN across the FILTERED call list (multicall3=%s)",
    async (multicall3) => {
      // Wave 2 does not read every route: it builds its call list from
      // `routeList.filter(r => r.sendLibrary)` and then assigns results back by
      // index over that FILTERED list. So there are two index spaces here, and
      // they diverge the moment any route fails its getSendLibrary read.
      // Assigning w2 results over `routeList` instead of `w2routes` shifts every
      // ULN past the first send-library-less route onto a neighbouring corridor —
      // a route's DVN set, and therefore its security verdict, would be read off
      // some other chain's config.
      //
      // Two things are needed to see it, and the 120-corridor equivalence fixture
      // has neither: the filter must actually REMOVE entries (otherwise the two
      // index spaces are identical), and each eid's ULN must be DISTINCT
      // (otherwise a shifted ULN is indistinguishable from the right one — the
      // shared fixture answers the same ulnZero for all 120). Mirrors the peer
      // ORDERING test below, which pins the same property for discovery.
      //
      // Run on both paths: the misassignment lives in the post-batch code they
      // share, so an identical shift on both would cancel out of any
      // batched-vs-unbatched equivalence assertion.
      const { handler } = fullHandler();
      const noSendLib = (eid: number) => eid % 13 === 4;
      const inner: Handler = (to, data) => {
        const sel = data.slice(0, 10);
        // A route with no send library is filtered OUT of wave 2, which is what
        // makes the filtered index space shorter than routeList's.
        if (sel === SEL.getSendLibrary) {
          return noSendLib(parseInt(data.slice(74, 138), 16)) ? "0x" : handler(to, data);
        }
        // requiredDVNCount doubles as a tag naming the eid this config belongs to.
        if (sel === SEL.getConfig) return buildUln(parseInt(data.slice(138, 202), 16) % 7);
        return handler(to, data);
      };
      const snap = await readSnapshot(
        OFT,
        chainRef([{ url: "u1", provider: "p1" }], { multicall3 }),
        deps({
          makeClient: makeFactory(
            { u1: { handler: multicall3 ? multicallHandler(perEidPeers(inner)) : perEidPeers(inner) } },
            [],
          ),
          loadEidMap: manyEidMap,
        }),
      );

      expect(snap.routes.length).toBe(MANY_EIDS.length);
      for (const r of snap.routes) {
        if (noSendLib(r.eid)) {
          // Never in wave 2's call list, so it can only hold a ULN it was handed
          // by mistake.
          expect(r.sendLibrary).toBeNull();
          expect(r.uln).toBeNull();
        } else {
          expect(r.uln).not.toBeNull();
          expect(r.uln!.requiredDVNCount).toBe(r.eid % 7);
        }
      }
      // Non-vacuity: the filter really did shorten the list, and there is a long
      // tail of routes AFTER the first removal for a shift to land on.
      const dropped = snap.routes.filter((r) => noSendLib(r.eid));
      expect(dropped.length).toBeGreaterThan(1);
      expect(snap.routes.length - dropped.length).toBeGreaterThan(50);
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

// ── Destination-side reads ───────────────────────────────────────────────────
// The third and last fan-out site. Per route it was three sequential eth_calls
// (getReceiveLibrary, getConfig, and the reverse-peer peers() check) against a
// client rebuilt from scratch for every route.
//
// Its index spaces are the most hazardous in the file. Routes are grouped by
// DESTINATION chain, and within a group there are two FILTERED lists:
//   `jobs`       — routes with a peer AND a destination the registry can resolve
//   `needConfig` — of those, the ones whose receive library actually decoded
// Neither lines up with routeList, and both are indexed positionally. A shift
// costs a route the config of one of its NEIGHBOURS on a different chain.

/** Address from a small integer — the same encoding peerForEid uses, so an
 *  address seen on the wire identifies the eid it belongs to. */
const addrFor = (n: number) => getAddress(("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`);
const eidOfAddr = (hex: string) => parseInt(hex.replace(/^0x/, ""), 16);

/** Per-eid distinct destination values. Distinctness is the whole point: the
 *  shared fixture answers the same bytes for every route, so a misassigned
 *  result there is indistinguishable from the right one. */
const recvLibFor = (eid: number) => addrFor(eid + 0x1000000);
const reversePeerFor = (eid: number) => addrFor(eid * 2);

const DST_A = "dst-a";
const DST_B = "dst-b";

/** Registry entries for the two destination chains. chainIds are outside the
 *  keyed-provider table (1 / 8453 / 5000) so ALCHEMY_API_KEY or DRPC_API_KEY in
 *  the ambient env cannot prepend an RPC and change rpcs[0]. */
function dstChains(mcA: boolean, mcB: boolean): Record<string, ChainRef> {
  const mk = (key: string, chainId: number, multicall3: boolean): ChainRef => ({
    chainKey: key, eid: chainId, chainId, eligible: true,
    etherscanFree: false, multicall3, rpcs: [{ url: key, provider: "p" }],
  });
  return { [DST_A]: mk(DST_A, 900_001, mcA), [DST_B]: mk(DST_B, 900_002, mcB) };
}

/** eid → destination chain. A third of the corridors land on a chainKey the
 *  registry does NOT know, so they are dropped from `jobs` and the job index
 *  space genuinely diverges from routeList's. */
const dstKeyFor = (eid: number) =>
  eid % 3 === 0 ? DST_A : eid % 3 === 1 ? DST_B : `nowhere-${eid}`;
const hasDst = (eid: number) => eid % 3 !== 2;
/** …and within a known destination, a fifth fail the receive-library read, so
 *  `needConfig` is in turn shorter than `jobs`. */
const noRecvLib = (eid: number) => eid % 5 === 0;

const splitEidMap = async () =>
  Object.fromEntries(
    MANY_EIDS.map((e) => [e, { chainKey: dstKeyFor(e), endpoint: ENDPOINT }]),
  );

/**
 * Destination-chain handler. Every answer is derived from the PEER address in
 * the calldata (or, for peers(), from the contract being called), which is
 * unique per eid — so a result landing on the wrong route is visible.
 */
const dstHandler: Handler = (to, data) => {
  const sel = data.slice(0, 10);
  if (sel === SEL.getReceiveLibrary) {
    const eid = eidOfAddr(data.slice(34, 74));
    return noRecvLib(eid) ? "0x" : "0x" + word(recvLibFor(eid)) + word("0");
  }
  if (sel === SEL.getConfig) {
    const eid = eidOfAddr(data.slice(34, 74));
    // A route whose receive LIBRARY was unreadable must never reach wave 2 at
    // all. This destination answers those routes with a perfectly valid ULN for
    // ANY library, so a defaulted or fabricated library — a `null` quietly
    // promoted into a positive claim about the receive config — surfaces as a
    // receiveUln that was never actually read.
    if (noRecvLib(eid)) return buildUln(eid % 7);
    // Otherwise the library argument must be the one wave 1 resolved for THIS
    // peer. A wave-2 call list that pairs a route with a neighbour's library
    // answers nothing, so a mis-BUILT batch shows up as a null ULN — separately
    // from the requiredDVNCount tag, which catches a mis-ASSIGNED result.
    if (eidOfAddr(data.slice(98, 138)) !== eid + 0x1000000) return "0x";
    return buildUln(eid % 7);
  }
  // peers() is called ON the destination peer contract, so `to` names the eid.
  if (sel === SEL.peers) return "0x" + word(reversePeerFor(eidOfAddr(to)));
  return "0x";
};

const srcHandler = perEidPeers(fullHandler().handler);

const byEid = (routes: RouteSnapshot[]) =>
  new Map(routes.map((r) => [r.eid, r] as const));

describe("destination-side reads — Multicall3 batching", () => {
  it("batches destination-side reads through aggregate3, not one call per route", async () => {
    setChainRegistryChains(dstChains(true, false));
    const log: string[] = [];
    const factory = makeFactory(
      {
        u1: { handler: multicallHandler(srcHandler) },
        [DST_A]: { handler: multicallHandler(dstHandler) },
        [DST_B]: { handler: dstHandler },
      },
      log,
    );

    await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
      deps({ makeClient: factory, loadEidMap: splitEidMap }),
    );

    const dstAgg = log.filter((l) => l.startsWith(`${DST_A}|`) && l.includes(AGG3_SEL)).length;
    const dstIndividual = log.filter((l) => l.startsWith(`${DST_A}|`) && !l.includes(AGG3_SEL)).length;
    expect(dstAgg).toBeGreaterThan(0);
    expect(dstIndividual).toBe(0);

    // dst-b has no Multicall3, so it must NOT be handed an aggregate3 payload —
    // batching against a contract that isn't deployed reads back as "no data"
    // for every route at once.
    expect(log.filter((l) => l.startsWith(`${DST_B}|`) && l.includes(AGG3_SEL))).toEqual([]);
    expect(log.filter((l) => l.startsWith(`${DST_B}|`)).length).toBeGreaterThan(0);
  });

  it("builds ONE client per destination chain, not one per route", async () => {
    setChainRegistryChains(dstChains(true, false));
    const built: string[] = [];
    const base = makeFactory(
      {
        u1: { handler: multicallHandler(srcHandler) },
        [DST_A]: { handler: multicallHandler(dstHandler) },
        [DST_B]: { handler: dstHandler },
      },
      [],
    );
    const factory = (url: string) => { built.push(url); return base(url); };

    const snap = await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
      deps({ makeClient: factory, loadEidMap: splitEidMap }),
    );

    // Non-vacuity: many routes really do share each destination chain.
    expect(snap.routes.filter((r) => dstKeyFor(r.eid) === DST_A).length).toBeGreaterThan(10);
    expect(built.filter((u) => u === DST_A)).toEqual([DST_A]);
    expect(built.filter((u) => u === DST_B)).toEqual([DST_B]);
  });

  it.each([true, false])(
    "ORDERING: every eid keeps its OWN destination reads across BOTH filtered index spaces (dst multicall3=%s)",
    async (dstMc) => {
      setChainRegistryChains(dstChains(dstMc, dstMc));
      const snap = await readSnapshot(
        OFT,
        chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
        deps({
          makeClient: makeFactory(
            {
              u1: { handler: multicallHandler(srcHandler) },
              [DST_A]: { handler: dstMc ? multicallHandler(dstHandler) : dstHandler },
              [DST_B]: { handler: dstMc ? multicallHandler(dstHandler) : dstHandler },
            },
            [],
          ),
          loadEidMap: splitEidMap,
        }),
      );

      expect(snap.routes.length).toBe(MANY_EIDS.length);
      for (const r of snap.routes) {
        if (!hasDst(r.eid)) {
          // Never in ANY job list. It can only hold a value handed to it by
          // mistake — and "we did not look" must never read as a finding.
          expect(r.receiveUln).toBeNull();
          expect(r.reversePeer ?? null).toBeNull();
          expect(r.peerSymmetric ?? null).toBeNull();
          continue;
        }
        // Wave 1 covers every job, including the ones wave 2 drops.
        expect(r.reversePeer).toBe(reversePeerFor(r.eid));
        expect(r.peerSymmetric).toBe(false);
        if (noRecvLib(r.eid)) {
          // Filtered OUT of wave 2 — this is where the two spaces diverge.
          expect(r.receiveUln).toBeNull();
        } else {
          expect(r.receiveUln).not.toBeNull();
          expect(r.receiveUln!.requiredDVNCount).toBe(r.eid % 7);
        }
      }

      // Non-vacuity: both filters really bite, and there is a long tail after
      // the first removal in each space for a shift to land on.
      expect(snap.routes.filter((r) => !hasDst(r.eid)).length).toBeGreaterThan(1);
      expect(snap.routes.filter((r) => hasDst(r.eid) && noRecvLib(r.eid)).length).toBeGreaterThan(1);
      expect(snap.routes.filter((r) => hasDst(r.eid) && !noRecvLib(r.eid)).length).toBeGreaterThan(50);
    },
  );

  it("EQUIVALENCE: identical destination-side results with and without multicall", async () => {
    // Same fixture data on both paths, so any difference is the batching.
    const run = async (mc: boolean) => {
      _resetCorridorCache();
      setChainRegistryChains(dstChains(mc, mc));
      return readSnapshot(
        OFT,
        chainRef([{ url: "u1", provider: "p1" }], { multicall3: mc }),
        deps({
          makeClient: makeFactory(
            {
              u1: { handler: mc ? multicallHandler(srcHandler) : srcHandler },
              [DST_A]: { handler: mc ? multicallHandler(dstHandler) : dstHandler },
              [DST_B]: { handler: mc ? multicallHandler(dstHandler) : dstHandler },
            },
            [],
          ),
          loadEidMap: splitEidMap,
        }),
      );
    };

    const plain = await run(false);
    const batched = await run(true);

    // Compared per eid rather than positionally: routes are appended in
    // completion order, which is not part of the contract.
    const p = byEid(plain.routes);
    const b = byEid(batched.routes);
    expect([...b.keys()].sort()).toEqual([...p.keys()].sort());
    expect(p.size).toBeGreaterThan(0); // guard against vacuous equality
    for (const [eid, pr] of p) expect(b.get(eid)).toEqual(pr);

    // The failure fixture is doing its job — otherwise "the two paths agree"
    // would only mean neither had to decide what an unread destination means.
    expect(plain.routes.filter((r) => r.receiveUln === null).length).toBeGreaterThan(0);
    expect(plain.routes.filter((r) => r.receiveUln !== null).length).toBeGreaterThan(0);
  });

  // A revert is the chain's verdict; a throw is our own failure to ask. Both
  // must land on null here — the receive side is the enforcement boundary, and
  // a wrong "we read it and it's fine" suppresses a real CRITICAL.
  const deadDstSpecs: [string, () => { handler: Handler }][] = [
    [
      "every destination read reverts",
      () => ({ handler: multicallHandler(() => errorStringRevert("nope")) }),
    ],
    [
      // aggregate3 itself fails, so the batch degrades to per-call — which also
      // throws. Transport failure end to end.
      "the destination RPC is unreachable",
      () => ({ handler: (() => { throw new Error("fetch failed"); }) as Handler }),
    ],
  ];

  it.each(deadDstSpecs)(
    "leaves receiveUln null and peerSymmetric null when %s",
    async (_name, mkSpec) => {
      setChainRegistryChains(dstChains(true, true));
      const dstSpec = mkSpec();

      const snap = await readSnapshot(
        OFT,
        chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
        deps({
          makeClient: makeFactory(
            { u1: { handler: multicallHandler(srcHandler) }, [DST_A]: dstSpec, [DST_B]: dstSpec },
            [],
          ),
          loadEidMap: splitEidMap,
        }),
      );

      expect(snap.routes.length).toBe(MANY_EIDS.length);
      for (const r of snap.routes) {
        expect(r.receiveUln).toBeNull();
        expect(r.reversePeer ?? null).toBeNull();
        // NOT false. `false` is the assertion "the destination does not peer
        // back", which is itself a CRITICAL-class finding; we did not look.
        expect(r.peerSymmetric ?? null).toBeNull();
      }
    },
  );

  it("keeps peerSymmetric null when only the reverse-peer read fails", async () => {
    // The partial-batch case: the receive side answers, the peers() sub-call
    // does not. A shared try/catch or a defaulted boolean would turn the second
    // failure into `false` and mint a half-wired-corridor finding out of it.
    setChainRegistryChains(dstChains(true, true));
    const partial: Handler = (to, data) =>
      data.slice(0, 10) === SEL.peers ? errorStringRevert("no peers()") : dstHandler(to, data);

    const snap = await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
      deps({
        makeClient: makeFactory(
          {
            u1: { handler: multicallHandler(srcHandler) },
            [DST_A]: { handler: multicallHandler(partial) },
            [DST_B]: { handler: multicallHandler(partial) },
          },
          [],
        ),
        loadEidMap: splitEidMap,
      }),
    );

    const readable = snap.routes.filter((r) => hasDst(r.eid) && !noRecvLib(r.eid));
    expect(readable.length).toBeGreaterThan(10);
    for (const r of readable) {
      expect(r.receiveUln!.requiredDVNCount).toBe(r.eid % 7); // receive side still read
      expect(r.peerSymmetric ?? null).toBeNull();
      expect(r.reversePeer ?? null).toBeNull();
    }
  });

  it("reports peerSymmetric true when the destination peers back to this OFT", async () => {
    setChainRegistryChains(dstChains(true, true));
    const symmetric: Handler = (to, data) =>
      data.slice(0, 10) === SEL.peers ? "0x" + word(OFT) : dstHandler(to, data);

    const snap = await readSnapshot(
      OFT,
      chainRef([{ url: "u1", provider: "p1" }], { multicall3: true }),
      deps({
        makeClient: makeFactory(
          {
            u1: { handler: multicallHandler(srcHandler) },
            [DST_A]: { handler: multicallHandler(symmetric) },
            [DST_B]: { handler: multicallHandler(symmetric) },
          },
          [],
        ),
        loadEidMap: splitEidMap,
      }),
    );

    const wired = snap.routes.filter((r) => hasDst(r.eid));
    expect(wired.length).toBeGreaterThan(10);
    for (const r of wired) {
      expect(r.peerSymmetric).toBe(true);
      expect(r.reversePeer).toBe(getAddress(OFT));
    }
  });
});
