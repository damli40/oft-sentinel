import { describe, it, expect, vi } from "vitest";

// Real resolveDvn would need the live metadata table. These tests are about the SHAPE of
// the rules (which side is scored, subset vs equality, what liveness may cap), not about
// name resolution, so stub the table and let the DVN "names" be the raw addresses — which
// resolveDvn returns verbatim when it has no entry. The address-fragment guard in the
// deliverability rule keys on a trailing "…", which these never have.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
    resolveDvn: (addr: string) => addr, // identity: the address IS the canonical name here
  };
});

import { assessSnapshot, capByLiveness, effectiveDvns, assessDeliverability } from "../services/drift.js";
import type { OftSnapshot, RouteSnapshot, UlnSnapshot, Finding, Liveness } from "../types.js";

const A = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b"; // stand-ins for three independent
const B = "0x8ddF05F9A5c488b4973897E278B58895bF87Cb24"; // DVN operators
const C = "0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5";
const D = "0xc9ca319f6Da263910fd9B037eC3d817A814ef3d8";

function uln(over: Partial<UlnSnapshot> = {}): UlnSnapshot {
  return {
    confirmations: 64,
    requiredDVNCount: 1,
    requiredDVNs: [A],
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    optionalDVNs: [],
    ...over,
  };
}

function route(over: Partial<RouteSnapshot> = {}): RouteSnapshot {
  return {
    eid: 30367,
    chainName: "hyperliquid",
    chainKey: "hyperliquid",
    sendLibrary: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
    sendLibIsDefault: false,
    receiveLibrary: "0x0000000000000000000000000000000000000001",
    receiveLibIsDefault: false,
    uln: uln(),
    receiveUln: null,
    peer: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    peerAddress: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    hasEnforcedOptions: true,
    isActive: true,
    liveness: "LIVE",
    ...over,
  };
}

function snap(routes: RouteSnapshot[]): OftSnapshot {
  return {
    oft: "0x00000000000000000000000000000000000f1c71", // synthetic — the SHAPE is the subject, not the asset
    chainId: 1,
    capturedAt: Date.now(),
    owner: "0x0000000000000000000000000000000000000002",
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes,
  };
}

const find = (fs: Finding[], check: string) => fs.filter((f) => f.check === check);

// ── The liveness law ────────────────────────────────────────────────────────
describe("capByLiveness", () => {
  const crit: Finding = { severity: "CRITICAL", evidence: "observed", check: "X", detail: "" };

  it("DORMANT caps at MEDIUM — no CRITICAL about money that cannot move", () => {
    expect(capByLiveness(crit, "DORMANT").severity).toBe("MEDIUM");
  });

  it("LIVE does not cap", () => {
    expect(capByLiveness(crit, "LIVE").severity).toBe("CRITICAL");
  });

  // The load-bearing one. UNKNOWN means the probe failed, NOT that the corridor is dead.
  // If an RPC hiccup could cap severity, Sentinel becomes a machine for suppressing
  // findings exactly when infrastructure is under stress.
  it("UNKNOWN NEVER caps — a failed probe must not suppress a real CRITICAL", () => {
    expect(capByLiveness(crit, "UNKNOWN").severity).toBe("CRITICAL");
  });

  it("never raises severity", () => {
    const low: Finding = { severity: "LOW", evidence: "observed", check: "X", detail: "" };
    for (const l of ["LIVE", "DORMANT", "UNKNOWN"] as Liveness[]) {
      expect(capByLiveness(low, l).severity).toBe("LOW");
    }
  });
});

// ── Deliverability is a SUBSET test ─────────────────────────────────────────
describe("assessDeliverability", () => {
  // The exact corridor shape that produced the false HIGH on a real, healthy asset.
  it("the false-positive shape: sender pays 3, receiver requires 1 + 1-of-2 — NOT blocked", () => {
    const d = assessDeliverability([A, B, C], [], [C], [B, A], 1);
    expect(d.blocked).toBe(false);
    expect(d.missingRequired).toEqual([]);
    // Every DVN the sender pays for is one the receiver counts: no mismatch at all.
    expect(d.overpaid).toEqual([]);
  });

  it("blocked when the receiver requires a DVN the sender does not pay", () => {
    const d = assessDeliverability([A, B], [], [D], [], 0);
    expect(d.blocked).toBe(true);
    expect(d.missingRequired).toEqual([D]);
  });

  it("blocked when the sender covers too few of the receiver's optional set", () => {
    const d = assessDeliverability([A], [], [], [B, C], 2); // needs 2 of {B,C}, pays neither
    expect(d.blocked).toBe(true);
    expect(d.optionalShortfall).toBe(2);
  });

  it("non-blocking when the sender overpays: messages flow, fees are wasted", () => {
    const d = assessDeliverability([A, B], [], [A], [], 0);
    expect(d.blocked).toBe(false);
    expect(d.overpaid).toEqual([B]); // paid on every message, counted by nobody
  });

  it("optional DVNs the sender pays count toward the receiver's threshold", () => {
    const d = assessDeliverability([A], [B], [A], [B, C], 1);
    expect(d.blocked).toBe(false);
  });
});

describe("effectiveDvns", () => {
  it("is required + optionalThreshold — the quorum an attacker must defeat", () => {
    expect(effectiveDvns(uln({ requiredDVNCount: 1, optionalDVNCount: 2, optionalDVNThreshold: 1 }))).toBe(2);
    expect(effectiveDvns(uln({ requiredDVNCount: 2, optionalDVNCount: 3, optionalDVNThreshold: 2 }))).toBe(4);
  });
});

// ── Security is scored on the RECEIVE side ──────────────────────────────────
describe("assessSnapshot — the receive side is the enforcement boundary", () => {
  // THE MISSED KELP. Until 4.0.0 the DVN Count rule read the SEND config, so this OFT —
  // paying three DVNs but accepting on one — scored PASS. The attacker only has to defeat
  // the quorum that ACCEPTS the message; what the sender paid for is irrelevant.
  it("fires CRITICAL when the RECEIVE side is 1-of-1, even though the send side pays 3", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
    })]);
    const { findings, riskLevel } = await assessSnapshot(s, "TKN");
    const dvn = find(findings, "DVN Count");
    expect(dvn).toHaveLength(1);
    expect(dvn[0].severity).toBe("CRITICAL");
    expect(dvn[0].evidence).toBe("observed");
    expect(riskLevel).toBe("CRITICAL");
  });

  // The healthy real-world shape: 1 required + 1-of-2 optional, three independent operators.
  it("scores that config as 2 effective DVNs (MEDIUM), not a block", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({
        requiredDVNCount: 1, requiredDVNs: [C],
        optionalDVNCount: 2, optionalDVNThreshold: 1, optionalDVNs: [A, B],
      }),
    })]);
    const { findings, riskLevel } = await assessSnapshot(s, "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("MEDIUM");
    expect(find(findings, "Undeliverable Route")).toHaveLength(0);
    expect(riskLevel).toBe("AT_RISK");
    expect(findings.some((f) => f.severity === "CRITICAL")).toBe(false);
  });

  it("a genuinely undeliverable route is still HIGH", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
      receiveUln: uln({ requiredDVNCount: 2, requiredDVNs: [C, D], optionalDVNCount: 0 }),
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const blocked = find(findings, "Undeliverable Route");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].severity).toBe("HIGH");
  });

  it("records a non-blocking mismatch as unscored PASS hygiene, never a severity", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({ requiredDVNCount: 2, requiredDVNs: [A, B] }), // C is paid, uncounted
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const nb = find(findings, "Non-Blocking DVN Mismatch");
    expect(nb).toHaveLength(1);
    expect(nb[0].severity).toBe("PASS");
    expect(find(findings, "Undeliverable Route")).toHaveLength(0);
  });
});

// ── A dead RECEIVE side is a blocked route, not a 1-of-1 ────────────────────
// Regression guard for a false CRITICAL that 4.0.0 briefly INTRODUCED. Scoring the
// receive side newly exposed the engine to a dead receive config, which the send-side-only
// Dead Pathway rule never guarded — and a receive set of [LZDeadDVN] reads as "1 effective
// DVN" and fired the Kelp CRITICAL. A dead DVN cannot attest, so it cannot be compromised
// to forge: the route is blocked, and the risk asserted did not exist. Found only by the
// 3.0.0-vs-4.0.0 fleet A/B against live data; every unit test passed.
describe("assessSnapshot — dead receive-side DVN set", () => {
  const DEAD = "0x000000000000000000000000000000000000dEaD";

  it("does NOT fire a Kelp CRITICAL when the destination's required DVN is a dead placeholder", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({ requiredDVNCount: 1, requiredDVNs: [DEAD] }),
    })]);
    const { findings, riskLevel } = await assessSnapshot(s, "TKN");
    expect(findings.some((f) => f.severity === "CRITICAL")).toBe(false);
    expect(find(findings, "DVN Count")).toHaveLength(0);
    expect(riskLevel).not.toBe("CRITICAL");
  });

  it("reports it as a blocked Dead Pathway (LOW) instead", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({ requiredDVNCount: 1, requiredDVNs: [DEAD] }),
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const dead = find(findings, "Dead Pathway");
    expect(dead).toHaveLength(1);
    expect(dead[0].severity).toBe("LOW");
    expect(dead[0].detail).toContain("DESTINATION");
  });

  // A REAL single DVN on the receive side must still fire. The dead-placeholder carve-out
  // must not become a hole the Kelp pattern can hide in.
  it("still fires CRITICAL when the destination requires ONE REAL DVN", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("CRITICAL");
  });
});

// ── The send side as a proxy, and the one case where it is a proof ──────────
describe("assessSnapshot — receive side unreadable", () => {
  // Kelp preserved. Only one DVN is PAID, so only one attestation can ever exist, so the
  // receiver cannot possibly require more than that one. Either the corridor is dead or it
  // is a genuine 1-of-1 — and deadness is capByLiveness's job, not the evidence law's.
  it("still fires CRITICAL when the sender pays exactly one DVN (no larger quorum can exist)", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
      receiveUln: null,
      liveness: "UNKNOWN",
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const dvn = find(findings, "DVN Count");
    expect(dvn[0].severity).toBe("CRITICAL");
    expect(dvn[0].evidence).toBe("observed");
  });

  // Here the send side really is only a proxy: three attestations exist, and the receiver
  // may require any subset of them. Claiming CRITICAL would assert more than we measured.
  it("caps at MEDIUM (inferred) when the sender pays several DVNs and the receiver is unreadable", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 1, requiredDVNs: [A], optionalDVNCount: 2, optionalDVNThreshold: 0, optionalDVNs: [B, C] }),
      receiveUln: null,
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const dvn = find(findings, "DVN Count");
    expect(dvn[0].evidence).toBe("inferred");
    expect(dvn[0].severity).not.toBe("CRITICAL");
  });
});

// ── Liveness gates severity end to end ──────────────────────────────────────
describe("assessSnapshot — liveness gate", () => {
  const kelp = (liveness: Liveness) => snap([route({
    uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
    receiveUln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
    liveness,
  })]);

  it("DORMANT corridor: the same 1-of-1 caps at MEDIUM — no paging on money that cannot move", async () => {
    const { findings, riskLevel } = await assessSnapshot(kelp("DORMANT"), "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("MEDIUM");
    expect(riskLevel).toBe("AT_RISK");
  });

  it("the cap lifts by itself the day the corridor goes LIVE", async () => {
    const { findings, riskLevel } = await assessSnapshot(kelp("LIVE"), "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("CRITICAL");
    expect(riskLevel).toBe("CRITICAL");
  });

  it("UNKNOWN liveness does not suppress the CRITICAL", async () => {
    const { findings } = await assessSnapshot(kelp("UNKNOWN"), "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("CRITICAL");
  });
});
