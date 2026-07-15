import { describe, it, expect } from "vitest";
import { weakConfigFingerprint } from "../services/orchestrator.js";
import type { Finding } from "../types.js";

// The bug this file guards against: route reads complete in nondeterministic order
// under concurrency, so the same finding SET arrives in a different array order each
// poll. The fingerprint is the dedup key for the weak-config attest+alert pipeline —
// if it is order-sensitive, every hourly cycle looks "new" and re-attests (gas) and
// re-alerts (Telegram) an unchanged config. Observed live 2026-07-15: ~10 CRITICAL
// assets re-firing every poll with set-equal, reordered findings.

const f = (check: string, detail: string, severity: Finding["severity"] = "HIGH"): Finding => ({
  severity,
  evidence: "observed",
  check,
  detail,
});

const A = f("Receive Library", "bsc: receive library is the upgradeable default.", "CRITICAL");
const B = f("Send Library Pinning", "bsc: send library is the upgradeable default.");
const C = f("DVN Count", "base: 2 effective DVNs: minimal redundancy.", "MEDIUM");

describe("weakConfigFingerprint — order-insensitive identity", () => {
  it("is identical for set-equal findings in any array order", () => {
    const orderings: Finding[][] = [
      [A, B, C],
      [C, B, A],
      [B, C, A],
    ];
    const prints = orderings.map((fs) => weakConfigFingerprint(fs, 0, "CRITICAL"));
    expect(new Set(prints).size).toBe(1);
  });

  it("changes when the finding SET changes", () => {
    expect(weakConfigFingerprint([A, B], 0, "CRITICAL"))
      .not.toBe(weakConfigFingerprint([A, B, C], 0, "CRITICAL"));
  });

  it("changes when a finding's severity or detail changes", () => {
    const escalated = { ...C, severity: "HIGH" as const };
    expect(weakConfigFingerprint([A, B, C], 0, "CRITICAL"))
      .not.toBe(weakConfigFingerprint([A, B, escalated], 0, "CRITICAL"));
    const reworded = { ...C, detail: C.detail + " (now 1 required)" };
    expect(weakConfigFingerprint([A, B, C], 0, "CRITICAL"))
      .not.toBe(weakConfigFingerprint([A, B, reworded], 0, "CRITICAL"));
  });

  it("changes when score or risk level changes", () => {
    expect(weakConfigFingerprint([A, B], 0, "CRITICAL"))
      .not.toBe(weakConfigFingerprint([A, B], 10, "CRITICAL"));
    expect(weakConfigFingerprint([A, B], 0, "CRITICAL"))
      .not.toBe(weakConfigFingerprint([A, B], 0, "AT_RISK"));
  });

  it("does not mutate the caller's findings array (PDR order is preserved)", () => {
    const findings = [C, A, B];
    weakConfigFingerprint(findings, 0, "CRITICAL");
    expect(findings).toEqual([C, A, B]);
  });
});
