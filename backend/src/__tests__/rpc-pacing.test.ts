import { describe, it, expect, beforeEach } from "vitest";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  OFT, fullHandler, failHandler, makeFactory, chainRef, deps,
  installHermeticChainRegistry,
} from "./helpers/fake-rpc.js";

installHermeticChainRegistry();
beforeEach(() => _resetCorridorCache());

/** Collect every sleep the reader requests, without actually waiting. */
function sleepSpy() {
  const ms: number[] = [];
  return { ms, sleep: async (n: number) => { ms.push(n); } };
}

describe("resilientCall pacing", () => {
  it("requests ZERO sleeps when every read succeeds", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    const factory = makeFactory({ p0: fullHandler() }, log);
    const chain = chainRef([{ url: "p0", provider: "official" }]);

    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0.5,
    }));

    // A healthy fleet must not pay the pacing cost. If this ever fails, the
    // delay leaked onto the success path and every cycle just got slower.
    expect(spy.ms).toEqual([]);
  });

  it("paces the primary retry and each fallback hop after a failure", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    // p0 fails everything → primary attempt, paced retry, then paced hop to p1.
    const factory = makeFactory(
      { p0: { handler: failHandler }, p1: fullHandler() },
      log,
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "drpc" },
    ]);

    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0.5,
    }));

    // jitter 0.5 → multiplier (0.5 + 0.5) = 1.0 → exact base values, so the
    // assertion pins WHICH delay was used at WHICH hop, not merely "some delay".
    expect(spy.ms.length).toBeGreaterThan(0);
    expect(new Set(spy.ms)).toEqual(new Set([150, 100]));
    // The retry delay must be requested before the first fallback delay.
    expect(spy.ms.indexOf(150)).toBeLessThan(spy.ms.indexOf(100));
  });

  it("scales the delay by the jitter seam", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    const factory = makeFactory(
      { p0: { handler: failHandler }, p1: fullHandler() },
      log,
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "drpc" },
    ]);

    // jitter 0 → multiplier 0.5 → half the base. Pins that jitter is actually
    // applied; a hardcoded `sleep(150)` passes the test above but fails here.
    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0,
    }));

    expect(new Set(spy.ms)).toEqual(new Set([75, 50]));
  });
});
