import { describe, it, expect, beforeEach } from "vitest";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  OFT, SEL, AGG3_SEL, fullHandler, makeFactory, multicallHandler,
  chainRef, rpc, deps, installHermeticChainRegistry, type Handler,
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
    // Primary 429s on the batch; the fallback client answers it fine.
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
});
