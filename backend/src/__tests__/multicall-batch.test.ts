import { describe, it, expect, beforeEach } from "vitest";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  OFT, SEL, AGG3_SEL, fullHandler, makeFactory, multicallHandler,
  chainRef, rpc, deps, installHermeticChainRegistry, type Handler,
  MANY_EIDS, manyEidMap, peerForEid, perEidPeers, errorStringRevert,
} from "./helpers/fake-rpc.js";

installHermeticChainRegistry();
beforeEach(() => _resetCorridorCache());

describe("resilientBatch", () => {
  it("uses aggregate3 when the chain supports it", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    await readSnapshot(OFT, chainRef([rpc("u1", "p1")], { multicall3: true }), deps({
      makeClient: makeFactory({ u1: { handler: multicallHandler(handler) } }, log),
    }));
    expect(log.some((l) => l.includes(AGG3_SEL))).toBe(true);
  });

  it("never uses aggregate3 when the chain does not support it", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    await readSnapshot(OFT, chainRef([rpc("u1", "p1")], { multicall3: false }), deps({
      makeClient: makeFactory({ u1: { handler } }, log),
    }));
    expect(log.some((l) => l.includes(AGG3_SEL))).toBe(false);
  });

  it("falls back to individual calls when the batch throws wholesale", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    // Answers individual selectors, but refuses aggregate3 entirely.
    const noBatch: Handler = (to, data) => {
      if (data.slice(0, 10) === AGG3_SEL) throw new Error("execution reverted");
      return handler(to, data);
    };
    const snap = await readSnapshot(OFT, chainRef([rpc("u1", "p1")], { multicall3: true }), deps({
      makeClient: makeFactory({ u1: { handler: noBatch } }, log),
    }));
    expect(snap.routes.length).toBeGreaterThan(0);
    expect(snap.routes[0].sendLibrary).not.toBeNull();
    expect(log.some((l) => l.includes(SEL.getSendLibrary))).toBe(true);
  });

  it("SAFETY: a rate-limited batch must not null out config it could not read", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    // Primary 429s on the batch. A second client is present and answers it, but
    // note this test does NOT pin WHICH recovery path runs: with the fallback
    // clients removed entirely it still passes, because the per-call path
    // degrades to a correct read too. What it pins is the outcome — a 429 never
    // presents as "no config" — not the route taken to it.
    const rateLimited: Handler = (to, data) => {
      if (data.slice(0, 10) === AGG3_SEL) throw new Error("429 Too Many Requests");
      return handler(to, data);
    };
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1"), rpc("u2", "p2")], { multicall3: true }),
      deps({
        makeClient: makeFactory(
          { u1: { handler: rateLimited }, u2: { handler: multicallHandler(handler) } },
          log,
        ),
      }),
    );
    // The read succeeded via the fallback — a 429 must never present as "no config".
    expect(snap.routes[0].uln).not.toBeNull();
    expect(snap.routes[0].sendLibrary).not.toBeNull();
  });

  it("maps a genuinely reverting sub-call to null without harming its neighbours", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    // enforcedOptions reverts; everything else is fine.
    const partial: Handler = (to, data) =>
      data.slice(0, 10) === SEL.enforcedOptions ? "0x" : handler(to, data);
    const snap = await readSnapshot(OFT, chainRef([rpc("u1", "p1")], { multicall3: true }), deps({
      makeClient: makeFactory({ u1: { handler: multicallHandler(partial) } }, log),
    }));
    expect(snap.routes[0].hasEnforcedOptions).toBeNull(); // the failed one
    expect(snap.routes[0].sendLibrary).not.toBeNull();     // its neighbours survived
  });

  it("BLAST RADIUS: an undecodable peers() word costs that corridor, not the snapshot", async () => {
    // multicall3: false — the per-call path, which serves the 16 eligible chains
    // with no Multicall3 and hands the RPC's bytes to the decoder verbatim.
    // BigInt("0xZZZZ") throws SyntaxError; unguarded, that rejects readSnapshot
    // for the whole token, so one bad RPC blinds the monitor on every corridor
    // instead of one.
    const bad = [MANY_EIDS[0], MANY_EIDS[7], MANY_EIDS[60]];
    const { handler } = fullHandler();
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1")], { multicall3: false }),
      deps({
        makeClient: makeFactory(
          { u1: { handler: perEidPeers(handler, { malformedFor: bad }) } },
          [],
        ),
        loadEidMap: manyEidMap,
      }),
    );

    const eids = snap.routes.map((r) => r.eid);
    expect(eids).toEqual(MANY_EIDS.filter((e) => !bad.includes(e)));
    for (const r of snap.routes) expect(r.peerAddress).toBe(peerForEid(r.eid));
  });

  it.each([true, false])(
    "ZERO PEER: an all-zero peers() word mints no corridor (multicall3=%s)",
    async (multicall3) => {
      // The common case on a real sweep: most of the ~120 known EIDs have no
      // peer and answer bytes32(0). Without the non-zero guard every one of them
      // becomes a phantom corridor with peer 0x0000…0000 — ~100 per token.
      const zero = MANY_EIDS.filter((_, i) => i % 3 !== 0);
      const live = MANY_EIDS.filter((_, i) => i % 3 === 0);
      const { handler } = fullHandler();
      const inner = perEidPeers(handler, { zeroFor: zero });
      const snap = await readSnapshot(
        OFT,
        chainRef([rpc("u1", "p1")], { multicall3 }),
        deps({
          makeClient: makeFactory(
            { u1: { handler: multicall3 ? multicallHandler(inner) : inner } },
            [],
          ),
          loadEidMap: manyEidMap,
        }),
      );

      expect(snap.routes.map((r) => r.eid)).toEqual(live);
      for (const r of snap.routes) {
        expect(r.peerAddress).toBe(peerForEid(r.eid));
        // The phantom shape, named explicitly so a regression is unmistakable.
        expect(r.peerAddress).not.toBe("0x0000000000000000000000000000000000000000");
      }
    },
  );

  it("SUB-CALL REVERT DATA: a reverting peers() is not decoded as a peer", async () => {
    // Multicall3 reports `require(false, msg)` as success=false WITH a non-empty
    // Error(string) payload. Read as return data, its last 20 bytes decode to a
    // perfectly well-formed address and mint a corridor that does not exist.
    // Only the success flag distinguishes it — the bytes themselves look fine.
    const reverting = [MANY_EIDS[2], MANY_EIDS[55]];
    const { handler } = fullHandler();
    const inner: Handler = (to, data) => {
      if (data.slice(0, 10) === SEL.peers) {
        const eid = parseInt(data.slice(10), 16);
        if (reverting.includes(eid)) return errorStringRevert("peer lookup failed");
      }
      return perEidPeers(handler)(to, data);
    };
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1")], { multicall3: true }),
      deps({
        makeClient: makeFactory({ u1: { handler: multicallHandler(inner) } }, []),
        loadEidMap: manyEidMap,
      }),
    );

    expect(snap.routes.map((r) => r.eid)).toEqual(
      MANY_EIDS.filter((e) => !reverting.includes(e)),
    );
    for (const r of snap.routes) expect(r.peerAddress).toBe(peerForEid(r.eid));
  });
});
