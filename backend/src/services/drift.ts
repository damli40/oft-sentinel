import type { OftSnapshot, RouteSnapshot, DriftResult, Finding, RiskLevel, TransactionIntent, Severity, Evidence, PreflightResult, CustodyDeclaration } from "../types.js";
import { computeScore } from "./score.js";
import { loadDvnMeta, resolveDvn, isDvnDeprecated, isDeadDvn, isSelfDvn } from "./lz-config.js";
import { getCustodyDeclaration } from "./custody.js";
import { getChainRef } from "./chain-registry.js";

/** The LZ chainKey of the snapshot's OWN chain. DVN names, ids and deprecation are all
 *  per-chain: the same address is a different operator on different chains. This was
 *  hardcoded to "mantle", which meant every ethereum/base asset resolved its DVNs
 *  against Mantle's table. Returns null (→ address fragments, no self-DVN credit,
 *  no deprecation claim) rather than guess a chain we don't recognize. */
function chainKeyOf(snap: OftSnapshot): string | null {
  return getChainRef(snap.chainId)?.chainKey ?? null;
}

// Bumped 1.0.0 → 1.1.0: Owner Type rule now consumes custody declarations
// (fireblocks_mpc downgrade).
// Bumped 1.1.0 → 1.2.0: pathways whose required DVN set is entirely an LZ Dead DVN
// placeholder are classified as unconfigured/blocked (LOW advisory), not scored as a
// live 1-of-1 / default-library CRITICAL — an un-wired placeholder is not a security
// posture the team chose (weETH Base→Zircuit false positive). A real single DVN still
// fires CRITICAL. Attestations made under earlier versions stay valid as recorded.
// Bumped 1.3.0 → 2.0.0 (MAJOR): every Finding now carries an `evidence` tag, which
// changes the Finding schema and therefore the PDR shape and its verdictHash.
// Attestations made under 1.x hash under the old schema and stay valid as recorded;
// recomputation of a 1.x verdict must use the 1.x PDR as stored.
//
// The evidence law replaces three hand-written severity downgrades (Fireblocks MPC,
// non-Safe proxy owner, and the general "we can't see custody" problem) with one rule.
//
// Bumped 2.0.0 → 2.1.0 (MINOR): no schema change, but finding CONTENT changes, so the
// PDR hash of a re-assessed snapshot moves.
//   1. srcChainKey is derived from the snapshot's own chain instead of the hardcoded
//      "mantle". DVN names, ids and deprecation are per-chain — the same address is a
//      different operator on different chains — so every non-Mantle asset was resolving
//      its DVN names against Mantle's table.
//   2. Self-DVN is identified by a curated ticker → operator-id allowlist rather than a
//      name substring test (which credited ticker "O" with operating "LayerZero Labs"),
//      and is therefore `observed` rather than `inferred`.
//   3. A failed proxyAdmin.owner() read no longer interpolates the string "undefined"
//      into the finding detail.
//
// Bumped 2.1.0 → 3.0.0 (MAJOR): the PDR gains `dvnMetaHash` + `dvnMetaFetchedAt`, so the
// shape and the verdictHash both change. 2.x attestations hash under the old schema and
// stay valid as recorded; recomputing a 2.x verdict must use the 2.x PDR as stored.
//
// Why the PDR had to grow: assessSnapshot() was never a pure function of
// (config, declarations). It also reads the LZ DVN metadata table, and a DVN deprecated
// upstream flips a severity with no config change at all. Now that we deliberately serve a
// stale table rather than an empty one on an API outage, that third input is a real
// variable and the determinism invariant ("same config → same verdict") is only honest if
// the verdict names the table it was computed against.
//
// Dead-DVN detection is also now strictly per-chain. `deadAddresses` was a flat
// cross-chain address union, but 14 addresses are an LZ Dead DVN placeholder on one chain
// and a live DVN on another (0x28b6140e… is dead on flare and "LayerZero Labs" on mantle).
// A flat union classifies a genuine 1-of-1 on such a DVN as an unconfigured dead pathway
// and SUPPRESSES its CRITICAL — the exact Kelp shape this rule exists to preserve. That is
// a severity change, hence MAJOR: a route that scored LOW/Dead Pathway may now score
// CRITICAL, correctly.
export const RULES_VERSION = "3.0.0";

// ── The evidence law ─────────────────────────────────────────────────────────
// CRITICAL and HIGH require directly observed evidence. An inferred finding caps at
// MEDIUM; an unverifiable one caps at LOW. This makes a false CRITICAL structurally
// impossible rather than merely unlikely: a rule cannot assert more than the reader
// measured. Rules propose (severity, evidence); this function is the only thing that
// decides the severity that ships.
const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, PASS: 4, UNKNOWN: 5,
};
const EVIDENCE_CEILING: Record<Evidence, Severity> = {
  observed: "CRITICAL",   // no cap
  inferred: "MEDIUM",
  unverifiable: "LOW",
};

/** Clamp a finding's severity to what its evidence can support. Never raises. */
export function capByEvidence(f: Finding): Finding {
  const ceiling = EVIDENCE_CEILING[f.evidence];
  // Lower rank number = more severe. Only weaken, never strengthen; PASS/UNKNOWN
  // (ranks 4/5) sit below every ceiling and are left untouched.
  if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[ceiling]) {
    return { ...f, severity: ceiling };
  }
  return f;
}

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
  const srcChainKey = chainKeyOf(next);

  for (const route of activeRoutes(next)) {
    const before = routeByEid(prev, route.eid);

    if (!before) {
      // Newly active route: flag if it starts in a risky state.
      // Skip unconfigured/dead pathways (required set entirely LZ Dead DVN) — a new
      // placeholder route is message-blocked, not a live 1-of-1 (see assessSnapshot's
      // Dead Pathway rule). Attesting it as a new SPOF would be a false alarm.
      if (route.uln && route.uln.requiredDVNs.length > 0 &&
          route.uln.requiredDVNs.every((a) => isDeadDvn(a, srcChainKey, dvnMeta))) {
        continue;
      }
      if (route.uln) {
        const newEffective = route.uln.requiredDVNCount + (route.uln.optionalDVNThreshold ?? 0);
        if (newEffective <= 1) {
          reasons.push(`${route.chainName}: new route added with 1-of-1 effective DVN: single point of failure`);
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

    // RPC source-conflict: newly detected disagreement between providers on this route.
    if (!before?.rpcConflict && route.rpcConflict) {
      reasons.push(`${route.chainName}: RPC providers disagree on required DVN configuration: possible source manipulation`);
    }

    // Only compare DVN count / confirmations when BOTH snapshots carry a real ULN
    // read. A null `uln` means the on-chain read failed (transient RPC) — coercing
    // "missing" to 0 would read as a downgrade and fire a false CRITICAL that gets
    // attested on-chain (real tx + MNT spend). Skip the comparison instead of guessing.
    if (before.uln && route.uln) {
      const prevEffective = before.uln.requiredDVNCount + (before.uln.optionalDVNThreshold ?? 0);
      const nextEffective = route.uln.requiredDVNCount + (route.uln.optionalDVNThreshold ?? 0);
      if (nextEffective < prevEffective) {
        reasons.push(`${route.chainName}: effective DVN count dropped ${prevEffective} → ${nextEffective}`);
      } else if (route.uln.requiredDVNCount < before.uln.requiredDVNCount) {
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

// UNKNOWN behaves like PASS for risk banding: an unevaluated check is not evidence
// of risk. LOW is advisory — it deducts score but doesn't flip the band (mirrors
// /oft-review, where LOW notes never change the verdict on their own).
function deriveRiskLevel(fs: Finding[]): RiskLevel {
  let risk: RiskLevel = "PASS";
  for (const f of fs) {
    const level: RiskLevel =
      f.severity === "CRITICAL" ? "CRITICAL"
      : f.severity === "HIGH" || f.severity === "MEDIUM" ? "AT_RISK"
      : "PASS";
    if (RISK_RANK[level] > RISK_RANK[risk]) risk = level;
  }
  return risk;
}

// Apply the AuditRegistry risk-band clamps (CRITICAL ≤25, AT_RISK ≤84).
function clampScore(raw: number, risk: RiskLevel): number {
  if (risk === "CRITICAL") return Math.min(raw, 25);
  if (risk === "AT_RISK") return Math.min(raw, 84);
  return raw;
}

/**
 * Deterministic risk assessment of a single snapshot.
 *
 * Checks (ported from /oft-review fetch_oft_config.py rule set):
 *   CRITICAL: 1-of-1 required DVN (Kelp rsETH exploit pattern)
 *   CRITICAL: deprecated DVN in required set (per LZ metadata)
 *   HIGH:     cross-chain DVN name mismatch (send vs receive — permanent message block)
 *   HIGH:     OFT owner is an EOA (LOW advisory if Fireblocks MPC custody is declared)
 *   HIGH:     proxy upgrade controlled by EOA (not a multisig)
 *   MEDIUM:   2-of-2 required DVNs (no redundancy)
 *   MEDIUM:   block confirmations < 15
 *   MEDIUM:   send library is the upgradeable default (not pinned)
 *   MEDIUM:   proxy upgrade controlled by a multisig (better than EOA, still notable)
 */
export async function assessSnapshot(
  snap: OftSnapshot,
  ticker?: string,
  // Custody declaration for this OFT's owner key. `undefined` = look it up from
  // the declarations store; `null` = explicitly none (tests / callers that
  // already resolved it). Declarations are an engine input and get embedded in
  // the findings they influence, so the PDR hash stays recomputable.
  custody?: CustodyDeclaration | null,
): Promise<{
  findings: Finding[];
  score: number;
  riskLevel: RiskLevel;
  tis: TransactionIntent[];
}> {
  const custodyDecl = custody !== undefined ? custody : getCustodyDeclaration(snap.oft, snap.chainId);
  const findings: Finding[] = [];
  // TIS: keyed by "intent|dvnAddress" to collapse identical issues across corridors into one entry.
  const tisMap = new Map<string, TransactionIntent>();
  // Pre-flight links: which findings each intent resolves, and the successor
  // finding (if any) the fixed config lands in — e.g. fixing 1-of-1 yields a
  // 2-of-2 config, which itself scores MEDIUM. Simulating the successor state
  // is what makes pre-flight deterministic instead of a naive deduction reversal.
  const tisLinks = new Map<string, { resolves: Finding[]; successors: Finding[] }>();

  function addTIS(
    key: string,
    corridor: string | null,
    entry: Omit<TransactionIntent, "corridors">,
    resolves?: Finding,
    successor?: Finding,
  ): void {
    if (!tisMap.has(key)) {
      tisMap.set(key, { ...entry, corridors: corridor ? [corridor] : undefined });
    } else if (corridor) {
      const ex = tisMap.get(key)!;
      if (!ex.corridors) ex.corridors = [];
      if (!ex.corridors.includes(corridor)) ex.corridors.push(corridor);
    }
    const link = tisLinks.get(key) ?? { resolves: [], successors: [] };
    if (resolves) link.resolves.push(resolves);
    if (successor) link.successors.push(successor);
    tisLinks.set(key, link);
  }

  const dvnMeta = await loadDvnMeta();
  // DVN names are keyed by LZ chainKey string ("mantle"), not numeric chain ID ("5000").
  const srcChainKey = chainKeyOf(snap);

  // Corridors with no enforced options — collapsed into one LOW finding below.
  const missingEnfOpts: string[] = [];

  for (const route of activeRoutes(snap)) {
    // ── RPC source conflict ─────────────────────────────────────────────────
    // Flagged by lz-config.ts when a secondary Mantle RPC returns different
    // requiredDVNs / counts. Either a compromised primary RPC is hiding a
    // security downgrade, or there is a genuine data inconsistency — both
    // require manual verification before trusting any automated verdict.
    if (route.rpcConflict) {
      const f: Finding = {
        severity: "CRITICAL",
        evidence: "observed",
        check: "RPC Source Conflict",
        detail: `${route.chainName}: multiple RPC providers disagree on the required DVN configuration: possible node manipulation or data inconsistency.`,
      };
      findings.push(f);
      addTIS("resolve_rpc_conflict", route.chainName, {
        intent: "resolve_rpc_conflict",
        action: "Manually verify DVN configuration on-chain before trusting this verdict",
        currentState: "Multiple RPC sources return conflicting DVN configs",
        targetState: "All RPC sources agree on the same DVN configuration",
        reason: "RPC disagreement may indicate node manipulation, stale data, or a mid-block state read",
        severity: "CRITICAL",
      }, f);
    }

    const uln = route.uln;
    if (!uln) {
      // UNKNOWN: read failed after retry + secondary-RPC fallback. Surfaced for
      // transparency but never deducts score — a transient infra failure must
      // not read as a security downgrade (USDT0 scored 50 from exactly this).
      findings.push({
        severity: "UNKNOWN",
        evidence: "unverifiable",
        check: "ULN Unreadable",
        detail: `${route.chainName}: ${route.sendLibrary ? "ULN config could not be read" : "send library not configured on endpoint"}. DVN and confirmation settings unverifiable on this corridor (not scored).`,
      });
      continue;
    }

    // ── Dead / unconfigured pathway ──────────────────────────────────────────
    // A required DVN set consisting entirely of LZ Dead DVN placeholders (0x…dEaD,
    // zero address, or a metadata-flagged "LZ Dead DVN") can never verify a message:
    // the pathway is unconfigured and message-blocked (LZ "Default Config D"), not a
    // live 1-of-1. A dead DVN cannot be compromised to forge messages (the Kelp
    // pattern) — it cannot attest at all — so scoring this route's 1-of-1 / default
    // libraries as CRITICAL is a false positive (weETH Base→Zircuit). Emit one visible
    // LOW advisory and skip this route's remaining rules. A real DVN in the required
    // set (functional count > 0) is unaffected and still scores normally below.
    if (uln.requiredDVNs.length > 0 && uln.requiredDVNs.every((a) => isDeadDvn(a, srcChainKey, dvnMeta))) {
      findings.push({
        severity: "LOW",
        evidence: "observed",
        check: "Dead Pathway",
        detail: `${route.chainName}: required DVN set is entirely an LZ Dead DVN placeholder — pathway not configured; messages are blocked and cannot be delivered. Not a live route (funds bridged here would be stuck until the OApp sets real DVNs).`,
      });
      continue;
    }

    const dstChainKey = route.chainKey; // destination chainKey — for DVN name lookup on dst

    // ── DVN count ───────────────────────────────────────────────────────────
    // Effective security = required DVNs + optional DVNs that must all sign (threshold).
    // e.g. 2 required + 3 optional threshold 2 → 4 distinct verifiers must agree.
    const effectiveDvnCount = uln.requiredDVNCount + (uln.optionalDVNThreshold ?? 0);
    const reqNames = uln.requiredDVNs.map((a) => resolveDvn(a, srcChainKey, dvnMeta)).join(", ");
    if (effectiveDvnCount <= 1) {
      const f: Finding = {
        severity: "CRITICAL",
        evidence: "observed",
        check: "DVN Count",
        detail: `${route.chainName}: 1-of-1 effective DVN (${reqNames || "unresolved"}): single point of failure (Kelp rsETH exploit pattern).`,
      };
      findings.push(f);
      // Successor: adding one DVN lands in the 2-of-2 state, which itself
      // scores MEDIUM — pre-flight must predict 84/AT_RISK, not 100/PASS.
      const successor: Finding = {
        severity: "MEDIUM",
        evidence: "observed",
        check: "DVN Count",
        detail: `${route.chainName}: 2 effective DVNs after fix: minimal redundancy.`,
      };
      addTIS("restore_dvn_redundancy", route.chainName, {
        intent: "restore_dvn_redundancy",
        action: "Add a second independent required DVN to the send configuration",
        dvnAddress: uln.requiredDVNs[0],
        dvnName: uln.requiredDVNs[0] ? resolveDvn(uln.requiredDVNs[0], srcChainKey, dvnMeta) : undefined,
        currentState: `1 effective DVN (${reqNames || "unresolved"}): single point of failure`,
        targetState: "≥2 independent required DVNs per message path",
        reason: "1-of-1 DVN config matches the Kelp rsETH exploit pattern. Single DVN compromise enables message forgery.",
        severity: "CRITICAL",
      }, f, successor);
    } else if (effectiveDvnCount === 2) {
      const f: Finding = {
        severity: "MEDIUM",
        evidence: "observed",
        check: "DVN Count",
        detail: `${route.chainName}: 2 effective DVNs (${reqNames}): minimal redundancy.`,
      };
      findings.push(f);
      addTIS("increase_dvn_redundancy", route.chainName, {
        intent: "increase_dvn_redundancy",
        action: "Add a third independent required DVN to strengthen verification",
        currentState: `2 effective DVNs (${reqNames}): one compromise breaks the quorum`,
        targetState: "≥3 independent required DVNs per message path",
        reason: "2-of-2 DVN config means a single DVN compromise or liveness failure halts all messages",
        severity: "MEDIUM",
      }, f);
    }

    // ── Deprecated DVNs ─────────────────────────────────────────────────────
    // Send config lives on the source chain (Mantle) — look up by srcChainKey.
    for (const dvnAddr of uln.requiredDVNs) {
      if (isDvnDeprecated(dvnAddr, srcChainKey, dvnMeta)) {
        const name = resolveDvn(dvnAddr, srcChainKey, dvnMeta);
        const f: Finding = {
          severity: "CRITICAL",
          evidence: "observed",
          check: "Deprecated DVN",
          detail: `${route.chainName}: required DVN "${name}" is deprecated: messages may halt.`,
        };
        findings.push(f);
        addTIS(`replace_deprecated_dvn|${dvnAddr.toLowerCase()}`, route.chainName, {
          intent: "replace_deprecated_dvn",
          action: `Replace deprecated DVN "${name}" with an active supported alternative`,
          dvnAddress: dvnAddr,
          dvnName: name,
          currentState: `"${name}" is deprecated: messages may permanently halt`,
          targetState: "Active, supported DVN in required set",
          reason: "Deprecated DVNs stop attesting messages, permanently blocking the route",
          severity: "CRITICAL",
        }, f);
      }
    }

    // ── Self-DVN detection (informational — NOT a deduction) ─────────────────
    // A protocol running its own DVN is ADDITIVE security: they verify on top of the
    // independent set, and they are the party with the most to lose from a forged
    // message. It is a plus, not a flaw, so this finding never deducts score.
    //
    // The "only one independent verifier" concern in a 2-of-2 set is a property of the
    // COUNT, not of who operates the DVN — and it is already scored by the DVN Count
    // 2-of-2 MEDIUM above. Deducting here too would double-count the same fact and
    // penalise the protocols doing the extra work.
    //
    // Kept as PASS so it still appears in the record (and in the PDR) as a positive
    // signal a reader can see.
    //
    // Identification is a curated ticker → DVN-operator-`id` allowlist (isSelfDvn), NOT
    // a name match. The previous substring test made ticker "O" match "LayerZero Labs"
    // and credited the O protocol with operating LayerZero's own DVN. An address that is
    // in the required set is read from the chain, and the address→operator mapping comes
    // from LZ's own published registry, so this is `observed`. (Evidence never raises a
    // PASS regardless; the tag is descriptive here.)
    if (ticker && effectiveDvnCount >= 2) {
      for (const dvnAddr of uln.requiredDVNs) {
        if (isSelfDvn(dvnAddr, ticker, srcChainKey, dvnMeta)) {
          findings.push({
            severity: "PASS",
            evidence: "observed",
            check: "Self-DVN",
            detail: `${route.chainName}: "${resolveDvn(dvnAddr, srcChainKey, dvnMeta)}" is operated by the protocol and sits in the required set: additive verification by the party with the most at stake.`,
          });
          break;
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
          const f: Finding = {
            severity: "HIGH",
            evidence: "observed",
            check: "DVN Mismatch",
            detail: `${route.chainName}: send DVNs [${sendNames.join(", ")}] != receive DVNs [${recvNames.join(", ")}]. Messages will be permanently blocked.`,
          };
          findings.push(f);
          addTIS(`resolve_dvn_mismatch`, route.chainName, {
            intent: "resolve_dvn_mismatch",
            action: "Align send and receive DVN sets so both sides verify the same providers",
            currentState: `Send [${sendNames.join(", ")}] ≠ receive [${recvNames.join(", ")}]`,
            targetState: "Matching DVN sets on send and receive sides",
            reason: "DVN mismatch means no message can be verified: permanent route block",
            severity: "HIGH",
          }, f);
        }
      }
    }

    // ── Block confirmations ──────────────────────────────────────────────────
    if (uln.confirmations > 0 && uln.confirmations < 15) {
      const f: Finding = {
        severity: "MEDIUM",
        evidence: "observed",
        check: "Confirmations",
        detail: `${route.chainName}: ${uln.confirmations} block confirmations (< 15, reorg risk).`,
      };
      findings.push(f);
      addTIS("increase_confirmations", route.chainName, {
        intent: "increase_confirmations",
        action: "Raise confirmation threshold to ≥15 blocks",
        currentState: `${uln.confirmations} block confirmation${uln.confirmations !== 1 ? "s" : ""}`,
        targetState: "≥15 block confirmations",
        reason: "Low confirmations expose the route to chain re-org attacks",
        severity: "MEDIUM",
      }, f);
    }

    // ── Enforced options ────────────────────────────────────────────────────
    // Collected per route, emitted as ONE fleet-wide LOW finding after the loop —
    // a per-corridor deduction would let a low-severity advisory (−5 × N routes)
    // outweigh a CRITICAL on wide deployments.
    if (route.hasEnforcedOptions === false) {
      missingEnfOpts.push(route.chainName);
    }

    // ── Send library pinning ─────────────────────────────────────────────────
    // Reference says HIGH: LZ Labs OneSig (3-of-5 EOAs) can redirect outbound
    // verification to a different library without the OFT team's involvement.
    if (route.sendLibIsDefault === true) {
      const f: Finding = {
        severity: "HIGH",
        evidence: "observed",
        check: "Send Library Pinning",
        detail: `${route.chainName}: send library is the upgradeable default. LZ Labs OneSig can redirect outbound verification unilaterally.`,
      };
      findings.push(f);
      addTIS("pin_send_library", route.chainName, {
        intent: "pin_send_library",
        action: "Pin the send library to a specific version",
        currentState: "Upgradeable default (LZ Labs-controlled)",
        targetState: "Pinned library address immutable to LZ Labs upgrades",
        reason: "Unpinned send library lets LZ Labs OneSig redirect outbound message verification",
        severity: "HIGH",
      }, f);
    }

    // ── Receive library pinning ──────────────────────────────────────────────
    // CRITICAL: inbound message acceptance path is controlled by LZ Labs, not
    // the OFT team. A library upgrade can accept forged messages regardless of
    // DVN config — this trust vector sits below DVN verification in the stack.
    if (route.receiveLibIsDefault === true) {
      const f: Finding = {
        severity: "CRITICAL",
        evidence: "observed",
        check: "Receive Library",
        detail: `${route.chainName}: receive library is the upgradeable default. LZ Labs can change inbound message acceptance rules unilaterally, bypassing DVN config.`,
      };
      findings.push(f);
      addTIS("pin_receive_library", route.chainName, {
        intent: "pin_receive_library",
        action: "Pin the receive library to a specific version",
        currentState: "Upgradeable default (LZ Labs-controlled)",
        targetState: "Pinned library address immutable to LZ Labs upgrades",
        reason: "Unpinned receive library lets LZ Labs change inbound acceptance rules, bypassing DVN config entirely",
        severity: "CRITICAL",
      }, f);
    }

    // ── Confirmation mismatch (send vs receive) ──────────────────────────────
    // If the destination chain requires more confirmations than the source sends,
    // the threshold is never met → permanent message block on that corridor.
    if (route.uln && route.receiveUln && route.receiveUln.confirmations > route.uln.confirmations) {
      const f: Finding = {
        severity: "HIGH",
        evidence: "observed",
        check: "Confirmation Mismatch",
        detail: `${route.chainName}: send confirmations (${route.uln.confirmations}) < receive required (${route.receiveUln.confirmations}). Messages will be permanently blocked.`,
      };
      findings.push(f);
      addTIS(`resolve_confirmation_mismatch`, route.chainName, {
        intent: "resolve_confirmation_mismatch",
        action: `Raise send confirmations to match the destination's required ${route.receiveUln.confirmations}`,
        currentState: `Send ${route.uln.confirmations} < receive required ${route.receiveUln.confirmations}`,
        targetState: `Send confirmations ≥ ${route.receiveUln.confirmations}`,
        reason: "Send confirmations below receive threshold permanently blocks message delivery",
        severity: "HIGH",
      }, f);
    }
  }

  // ── Enforced options (fleet-wide) ────────────────────────────────────────
  if (missingEnfOpts.length > 0) {
    const f: Finding = {
      severity: "LOW",
      evidence: "observed",
      check: "Enforced Options",
      detail: `No enforced options set on ${missingEnfOpts.length} corridor${missingEnfOpts.length > 1 ? "s" : ""} (${missingEnfOpts.join(", ")}): zero-gas messages can permanently stick channel nonces.`,
    };
    findings.push(f);
    addTIS("set_enforced_options", null, {
      intent: "set_enforced_options",
      action: "Call setEnforcedOptions() with an lzReceive gas floor (≥65k) for each destination EID",
      currentState: `No enforced options on ${missingEnfOpts.length} corridor${missingEnfOpts.length > 1 ? "s" : ""}`,
      targetState: "Enforced lzReceive gas floor on every active corridor",
      reason: "Without enforced options, zero-gas messages can permanently stick channel nonces",
      severity: "LOW",
    }, f);
    tisMap.get("set_enforced_options")!.corridors = [...missingEnfOpts];
  }

  // ── Owner type ───────────────────────────────────────────────────────────
  // On-chain data cannot distinguish an MPC-custodied EOA (e.g. Fireblocks)
  // from a raw hot wallet, so a declared custody type modulates this rule:
  //   fireblocks_mpc → LOW advisory, marked declared-unverified
  //   safe_multisig  → HIGH + mismatch note (a real Safe is a contract, not an EOA)
  //   eoa_hot / unknown / none → HIGH, unchanged
  if (snap.ownerIsContract === false) {
    // The chain observes: the owner address has no bytecode. What it CANNOT observe is
    // who holds the key. A declared MPC custodian (Fireblocks) makes the "single private
    // key" claim unverifiable, so the law caps it at LOW — no hand-written downgrade.
    // A declared Safe is contradicted by chain state (a Safe has bytecode), so that
    // claim stays observed, and stays HIGH.
    const mpcDeclared = custodyDecl?.custodyType === "fireblocks_mpc";
    const mismatch = custodyDecl?.custodyType === "safe_multisig";
    const f: Finding = {
      severity: "HIGH",
      evidence: mpcDeclared ? "unverifiable" : "observed",
      check: "Owner Type",
      detail: mpcDeclared
        ? "owner is EOA on-chain; declared Fireblocks MPC custody (declared, unverified)."
        : mismatch
          ? "OFT owner is an EOA: config can be changed by a single private key. Note: declared Safe multisig custody contradicts chain state (a Safe is a contract, not an EOA)."
          : "OFT owner is an EOA: config can be changed by a single private key.",
      ...(custodyDecl ? { custodyDeclaration: custodyDecl } : {}),
    };
    findings.push(f);
    // No ownership-transfer remediation demanded for declared MPC (advisory only).
    if (!mpcDeclared) {
      addTIS("transfer_ownership_to_multisig", null, {
        intent: "transfer_ownership_to_multisig",
        action: "Transfer OFT ownership to a multisig (e.g. Gnosis Safe)",
        currentState: "EOA owner: single private key controls all configuration",
        targetState: "Multisig owner: M-of-N signers required for config changes",
        reason: "EOA ownership means a single key compromise can alter DVN config, message libraries, or peer addresses",
        severity: "HIGH",
      }, f);
    }
  }

  // ── Proxy upgrade path ───────────────────────────────────────────────────
  // A failed GnosisSafe probe (getThreshold() reverts) does NOT mean the owner is an
  // EOA — timelocks, custom multisigs and governance contracts all revert it while
  // being contracts. Claiming "EOA" on those is an over-assertion of the same class as
  // the Fireblocks/EOA custody false positive: on-chain data cannot see governance.
  // Branch on bytecode, and only say "EOA" when the owner genuinely has none.
  // `proxyAdminOwner` is null when the ProxyAdmin's owner() read itself failed. Never
  // interpolate the raw value: `undefined.slice()` short-circuits to the string
  // "undefined" and ships "Proxy admin owner (undefined...)" into the PDR.
  const owner10 = snap.proxyAdminOwner ? `${snap.proxyAdminOwner.slice(0, 10)}...` : "owner() unreadable";
  if (snap.proxyAdmin !== null && snap.proxyAdminIsMultisig !== true) {
    if (snap.proxyAdminOwnerIsContract === false) {
      // Genuine EOA: no bytecode. A single private key really can upgrade.
      const f: Finding = {
        severity: "HIGH",
        evidence: "observed",
        check: "Proxy Upgrade Control",
        detail: `Proxy admin owner is an EOA (${owner10}): a single key can upgrade the implementation.`,
      };
      findings.push(f);
      addTIS("transfer_proxy_admin_to_multisig", null, {
        intent: "transfer_proxy_admin_to_multisig",
        action: "Transfer proxy admin control to a multisig",
        currentState: `EOA proxy admin (${owner10})`,
        targetState: "Multisig-controlled proxy upgrade path",
        reason: "EOA proxy admin means a single key can upgrade the OFT implementation",
        severity: "HIGH",
      }, f);
    } else if (snap.proxyAdminOwnerIsContract === true) {
      // Contract owner that isn't a recognized Safe (e.g. OZ TimelockController).
      // Strictly better than an EOA. Its governance (proposer set, delay) is not on
      // chain-readable, so the claim is unverifiable and the law caps it at LOW.
      findings.push({
        severity: "HIGH",
        evidence: "unverifiable",
        check: "Proxy Upgrade Control",
        detail: `Proxy admin owner (${owner10}) is a contract but not a recognized Gnosis Safe (e.g. a timelock or custom multisig). Upgrade governance is not verifiable on-chain (unverified).`,
      });
    } else {
      // Bytecode unreadable — never score an unevaluated check (mirrors ULN Unreadable).
      findings.push({
        severity: "UNKNOWN",
        evidence: "unverifiable",
        check: "Proxy Upgrade Control",
        detail: `Proxy admin owner (${owner10}) bytecode could not be read: upgrade control unverifiable on this snapshot (not scored).`,
      });
    }
  }
  // Multisig-controlled proxy is the recommended configuration — no deduction.

  // If every active corridor was unreadable, the posture is unverified — surface
  // one MEDIUM so the OFT reads AT_RISK rather than a false 100/PASS.
  const active = activeRoutes(snap);
  if (active.length > 0 && active.every((r) => !r.uln)) {
    findings.push({
      severity: "MEDIUM",
      evidence: "observed",
      check: "Coverage",
      detail: "All corridors unreadable after retries: security posture cannot be verified.",
    });
  }

  // ── Enforce the evidence law ─────────────────────────────────────────────
  // Single choke point: no rule above can ship a severity its evidence doesn't
  // support. Mutated in place (not mapped to new objects) because the pre-flight
  // simulation below matches findings by object identity.
  for (const f of findings) {
    const capped = capByEvidence(f);
    if (capped.severity !== f.severity) f.severity = capped.severity;
  }

  const riskLevel = deriveRiskLevel(findings);
  // Keep the attested score coherent with AuditRegistry's documented risk bands.
  const score = clampScore(computeScore(findings), riskLevel);

  const SEV_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, PASS: 4, UNKNOWN: 5 };
  const tis = [...tisMap.values()].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  // Pre-flight: simulate the post-fix findings set (resolved findings removed,
  // successor findings added) and re-run the exact same deterministic scoring +
  // clamps. Fixing a 1-of-1 thus correctly predicts the 2-of-2 successor state
  // (84/AT_RISK), not a naive deduction reversal (100/PASS).
  for (const [key, intent] of tisMap) {
    const link = tisLinks.get(key);
    const resolved = new Set(link?.resolves ?? []);
    const simulated = findings.filter((f) => !resolved.has(f)).concat(link?.successors ?? []);
    const riskAfter = deriveRiskLevel(simulated);
    const preflight: PreflightResult = {
      scoreBefore: score,
      riskBefore: riskLevel,
      scoreAfter: clampScore(computeScore(simulated), riskAfter),
      riskAfter,
    };
    intent.preflight = preflight;
  }

  return { findings, score, riskLevel, tis };
}
