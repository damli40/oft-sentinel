import type { OftSnapshot, RouteSnapshot, DriftResult, Finding, RiskLevel } from "../types.js";
import { computeScore } from "./score.js";
import { loadDvnMeta, resolveDvn, isDvnDeprecated } from "./lz-config.js";

function activeRoutes(snap: OftSnapshot): RouteSnapshot[] {
  return snap.routes.filter((r) => r.isActive);
}

function routeByEid(snap: OftSnapshot, eid: number): RouteSnapshot | undefined {
  return snap.routes.find((r) => r.eid === eid);
}

/**
 * Diff a fresh snapshot against the last-known-good one. Drift = the config moved
 * in a security-relevant direction on a live route: fewer required DVNs, lower
 * confirmations, a pinned library reverting to the upgradeable default,
 * a deprecated DVN newly appearing in the required set, or a new 1-of-1 route.
 */
export async function detectDrift(prev: OftSnapshot, next: OftSnapshot): Promise<DriftResult> {
  const reasons: string[] = [];
  const dvnMeta = await loadDvnMeta();
  const srcChainKey = "mantle";

  for (const route of activeRoutes(next)) {
    const before = routeByEid(prev, route.eid);

    if (!before) {
      // Newly active route: flag if it starts in a risky state.
      if (route.uln) {
        if (route.uln.requiredDVNCount <= 1) {
          reasons.push(`${route.chainName}: new route added with 1-of-1 required DVN — single point of failure`);
        }
        for (const dvnAddr of route.uln.requiredDVNs) {
          if (isDvnDeprecated(dvnAddr, srcChainKey, dvnMeta)) {
            const name = resolveDvn(dvnAddr, srcChainKey, dvnMeta);
            reasons.push(`${route.chainName}: new route added with deprecated required DVN "${name}"`);
          }
        }
      }
      continue;
    }

    // Only compare DVN count / confirmations when BOTH snapshots carry a real ULN
    // read. A null `uln` means the on-chain read failed (transient RPC) — coercing
    // "missing" to 0 would read as a downgrade and fire a false CRITICAL that gets
    // attested on-chain (real tx + MNT spend). Skip the comparison instead of guessing.
    if (before.uln && route.uln) {
      if (route.uln.requiredDVNCount < before.uln.requiredDVNCount) {
        reasons.push(`${route.chainName}: required DVN count dropped ${before.uln.requiredDVNCount} → ${route.uln.requiredDVNCount}`);
      }
      if (route.uln.confirmations < before.uln.confirmations) {
        reasons.push(`${route.chainName}: confirmations fell ${before.uln.confirmations} → ${route.uln.confirmations}`);
      }

      // DVN identity check: a same-count swap can silently replace a good DVN with a
      // deprecated one. Flag any DVN address newly in the required set that is deprecated.
      const prevSet = new Set(before.uln.requiredDVNs.map((a) => a.toLowerCase()));
      for (const dvnAddr of route.uln.requiredDVNs) {
        if (!prevSet.has(dvnAddr.toLowerCase()) && isDvnDeprecated(dvnAddr, srcChainKey, dvnMeta)) {
          const name = resolveDvn(dvnAddr, srcChainKey, dvnMeta);
          reasons.push(`${route.chainName}: deprecated DVN "${name}" newly added to required set`);
        }
      }
    }

    if (before.sendLibIsDefault === false && route.sendLibIsDefault === true) {
      reasons.push(`${route.chainName}: send library reverted to the upgradeable default`);
    }
    if (before.receiveLibIsDefault === false && route.receiveLibIsDefault === true) {
      reasons.push(`${route.chainName}: receive library reverted to the upgradeable default`);
    }
  }

  return { drifted: reasons.length > 0, reasons };
}

const RISK_RANK: Record<RiskLevel, number> = { PASS: 0, AT_RISK: 1, CRITICAL: 2 };

/**
 * Deterministic risk assessment of a single snapshot.
 *
 * Checks (ported from /oft-review fetch_oft_config.py rule set):
 *   CRITICAL: 1-of-1 required DVN (Kelp rsETH exploit pattern)
 *   CRITICAL: deprecated DVN in required set (per LZ metadata)
 *   HIGH:     cross-chain DVN name mismatch (send vs receive — permanent message block)
 *   HIGH:     OFT owner is an EOA
 *   HIGH:     proxy upgrade controlled by EOA (not a multisig)
 *   MEDIUM:   2-of-2 required DVNs (no redundancy)
 *   MEDIUM:   block confirmations < 15
 *   MEDIUM:   send library is the upgradeable default (not pinned)
 *   MEDIUM:   proxy upgrade controlled by a multisig (better than EOA, still notable)
 */
export async function assessSnapshot(snap: OftSnapshot, ticker?: string): Promise<{
  findings: Finding[];
  score: number;
  riskLevel: RiskLevel;
}> {
  const findings: Finding[] = [];
  const dvnMeta = await loadDvnMeta();
  // DVN names are keyed by LZ chainKey string ("mantle"), not numeric chain ID ("5000").
  const srcChainKey = "mantle";

  for (const route of activeRoutes(snap)) {
    const uln = route.uln;
    if (!uln) continue;
    const dstChainKey = route.chainKey; // destination chainKey — for DVN name lookup on dst

    // ── DVN count ───────────────────────────────────────────────────────────
    const reqNames = uln.requiredDVNs.map((a) => resolveDvn(a, srcChainKey, dvnMeta)).join(", ");
    if (uln.requiredDVNCount <= 1) {
      findings.push({
        severity: "CRITICAL",
        check: "DVN Count",
        detail: `${route.chainName}: 1-of-1 required DVN (${reqNames || "unresolved"}) — single point of failure (Kelp rsETH exploit pattern).`,
      });
    } else if (uln.requiredDVNCount === 2) {
      findings.push({
        severity: "MEDIUM",
        check: "DVN Count",
        detail: `${route.chainName}: 2-of-2 required DVNs (${reqNames}) — minimal redundancy.`,
      });
    }

    // ── Deprecated DVNs ─────────────────────────────────────────────────────
    // Send config lives on the source chain (Mantle) — look up by srcChainKey.
    for (const dvnAddr of uln.requiredDVNs) {
      if (isDvnDeprecated(dvnAddr, srcChainKey, dvnMeta)) {
        const name = resolveDvn(dvnAddr, srcChainKey, dvnMeta);
        findings.push({
          severity: "CRITICAL",
          check: "Deprecated DVN",
          detail: `${route.chainName}: required DVN "${name}" is deprecated — messages may halt.`,
        });
      }
    }

    // ── Self-DVN detection ───────────────────────────────────────────────────
    // A protocol running one of its own required DVNs means it can verify its
    // own messages — defeating the independence assumption. LOW because it's
    // intentional (e.g. USDT0 DVN), not a configuration error, but a material
    // trust assumption that should surface in reports.
    if (ticker) {
      const tickerLower = ticker.toLowerCase();
      for (const dvnAddr of uln.requiredDVNs) {
        const name = resolveDvn(dvnAddr, srcChainKey, dvnMeta).toLowerCase();
        if (name !== dvnAddr.toLowerCase().slice(0, 8) + "…" && name.includes(tickerLower)) {
          findings.push({
            severity: "LOW",
            check: "Self-DVN",
            detail: `${route.chainName}: "${resolveDvn(dvnAddr, srcChainKey, dvnMeta)}" is operated by the protocol — reduces DVN independence.`,
          });
          break; // one finding per route, not per DVN
        }
      }
    }

    // ── Cross-chain DVN mismatch ─────────────────────────────────────────────
    // Compare source send-DVN names (resolved on source chain) against
    // destination receive-DVN names (resolved on destination chain).
    // A mismatch = permanent message block (per LZ V2 docs).
    //
    // Guard: only compare when EVERY DVN on BOTH sides resolves to a canonical
    // name (not a raw address fragment). An unresolved address compares unequal
    // by definition — that is a resolution gap, not a real mismatch — and would
    // fire a false HIGH. Linea has no entry in the DVN metadata API; those
    // routes safely fall through here.
    if (uln.requiredDVNs.length > 0 && route.receiveUln?.requiredDVNs?.length) {
      const sendNames = uln.requiredDVNs.map((a) => resolveDvn(a, srcChainKey, dvnMeta));
      const recvNames = route.receiveUln.requiredDVNs.map((a) => resolveDvn(a, dstChainKey, dvnMeta));
      const isResolved = (name: string) => !name.endsWith("…"); // address fragment = unresolved
      const allResolved = sendNames.every(isResolved) && recvNames.every(isResolved);
      if (allResolved) {
        const sendSet = new Set(sendNames);
        const recvSet = new Set(recvNames);
        if (sendSet.size !== recvSet.size || [...sendSet].some((n) => !recvSet.has(n))) {
          findings.push({
            severity: "HIGH",
            check: "DVN Mismatch",
            detail: `${route.chainName}: send DVNs [${sendNames.join(", ")}] ≠ receive DVNs [${recvNames.join(", ")}] — messages will be permanently blocked.`,
          });
        }
      }
    }

    // ── Block confirmations ──────────────────────────────────────────────────
    if (uln.confirmations > 0 && uln.confirmations < 15) {
      findings.push({
        severity: "MEDIUM",
        check: "Confirmations",
        detail: `${route.chainName}: ${uln.confirmations} block confirmations (< 15 — reorg risk).`,
      });
    }

    // ── Enforced options ────────────────────────────────────────────────────
    if (route.hasEnforcedOptions === false) {
      findings.push({
        severity: "LOW",
        check: "Enforced Options",
        detail: `${route.chainName}: no enforced options set — zero-gas messages can permanently stuck nonces.`,
      });
    }

    // ── Send library pinning ─────────────────────────────────────────────────
    // Reference says HIGH: LZ Labs OneSig (3-of-5 EOAs) can redirect outbound
    // verification to a different library without the OFT team's involvement.
    if (route.sendLibIsDefault === true) {
      findings.push({
        severity: "HIGH",
        check: "Send Library Pinning",
        detail: `${route.chainName}: send library is the upgradeable default — LZ Labs OneSig can redirect outbound verification unilaterally.`,
      });
    }

    // ── Receive library pinning ──────────────────────────────────────────────
    // CRITICAL: inbound message acceptance path is controlled by LZ Labs, not
    // the OFT team. A library upgrade can accept forged messages regardless of
    // DVN config — this trust vector sits below DVN verification in the stack.
    if (route.receiveLibIsDefault === true) {
      findings.push({
        severity: "CRITICAL",
        check: "Receive Library",
        detail: `${route.chainName}: receive library is the upgradeable default — LZ Labs can change inbound message acceptance rules unilaterally, bypassing DVN config.`,
      });
    }

    // ── Confirmation mismatch (send vs receive) ──────────────────────────────
    // If the destination chain requires more confirmations than the source sends,
    // the threshold is never met → permanent message block on that corridor.
    if (route.uln && route.receiveUln && route.receiveUln.confirmations > route.uln.confirmations) {
      findings.push({
        severity: "HIGH",
        check: "Confirmation Mismatch",
        detail: `${route.chainName}: send confirmations (${route.uln.confirmations}) < receive required (${route.receiveUln.confirmations}) — messages will be permanently blocked.`,
      });
    }
  }

  // ── Owner type ───────────────────────────────────────────────────────────
  if (snap.ownerIsContract === false) {
    findings.push({
      severity: "HIGH",
      check: "Owner Type",
      detail: "OFT owner is an EOA — config can be changed by a single private key.",
    });
  }

  // ── Proxy upgrade path ───────────────────────────────────────────────────
  if (snap.proxyAdmin !== null) {
    if (snap.proxyAdminIsMultisig === false) {
      findings.push({
        severity: "HIGH",
        check: "Proxy Upgrade Control",
        detail: `Proxy admin owner is an EOA (${snap.proxyAdminOwner?.slice(0, 10)}…) — a single key can upgrade the implementation.`,
      });
    } else if (snap.proxyAdminIsMultisig === true) {
      findings.push({
        severity: "MEDIUM",
        check: "Proxy Upgrade Control",
        detail: `Proxy upgradeable — controlled by a multisig (${snap.proxyAdminOwner?.slice(0, 10)}…). Verify threshold and signer set.`,
      });
    }
  }

  let score = computeScore(findings);

  let riskLevel: RiskLevel = "PASS";
  for (const f of findings) {
    const level: RiskLevel = f.severity === "CRITICAL" ? "CRITICAL" : f.severity === "PASS" ? "PASS" : "AT_RISK";
    if (RISK_RANK[level] > RISK_RANK[riskLevel]) riskLevel = level;
  }

  // Keep the attested score coherent with AuditRegistry's documented risk bands.
  if (riskLevel === "CRITICAL") score = Math.min(score, 25);
  if (riskLevel === "AT_RISK") score = Math.min(score, 84);

  return { findings, score, riskLevel };
}
