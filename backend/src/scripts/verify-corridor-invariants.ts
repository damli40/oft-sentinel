/**
 * verify-corridor-invariants — assert, against the LIVE chains, the corridor facts the
 * rule engine's correctness depends on.
 *
 * Why this exists
 * ───────────────
 * Sibling to verify-dvn-invariants.ts, and written for the same reason. That one exists
 * because a passing unit test pinned a false belief about the DVN metadata feed. This one
 * exists because the engine spent weeks reporting a HIGH on a corridor — "send DVNs !=
 * receive DVNs, messages will be permanently blocked" — that was live, delivering, and
 * healthy the entire time. It was one edit away from being sent to LayerZero as a finding.
 *
 * Three beliefs, none of them ever checked against a chain, produced it:
 *   1. that a DVN mismatch means blocked       (it does not: the test is a SUBSET test)
 *   2. that the send side carries the security (it does not: the RECEIVE side accepts)
 *   3. that a wired corridor is a live one     (it need not be: teams pre-wire chains)
 *
 * A hermetic fixture can only prove the code does what its author believed. It cannot
 * prove the belief. So the beliefs get derived from the chain, and have to fail when
 * reality moves.
 *
 * Deliberately NOT part of `vitest run`: it needs RPC access, and a monitor's test suite
 * must stay hermetic. Run it before touching anything in the DVN or deliverability layer.
 *
 *   npx tsx src/scripts/verify-corridor-invariants.ts
 *
 * The corridor table lives at `DATA_DIR/corridor-invariants.json`, which is NOT in the
 * repo: per-asset configuration detail stays local, so this file names no asset. Absent
 * fixture → the script skips cleanly rather than failing a build.
 *
 * Exits non-zero when an invariant breaks. A break does not necessarily mean Sentinel is
 * wrong — a team can legitimately rewire a corridor — but it always means a rule, a
 * comment or an expectation somewhere is now lying, and someone has to look.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSnapshot, loadDvnMeta, resolveDvn, type DvnMeta } from "../services/lz-config.js";
import { assessSnapshot, effectiveDvns, assessDeliverability } from "../services/drift.js";
import { getChainRef } from "../services/chain-registry.js";

interface CorridorCase {
  name: string;
  oft: string;
  srcChainId: number;
  srcChainKey: string;
  dstChainKey: string;
  why?: string;
  expect: {
    receiveEffectiveDvns?: number;
    blocked?: boolean;
    liveness?: string;
    sharedOperatorAcrossChains?: string;
    noUndeliverableFinding?: boolean;
    noCritical?: boolean;
  };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  if (!ok) failures++;
}

function loadCases(): CorridorCase[] {
  const path = join(process.env.DATA_DIR ?? "data", "corridor-invariants.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")).cases ?? [];
  } catch {
    console.log(`no corridor fixture at ${path} — nothing to verify (this is not a failure)`);
    return [];
  }
}

async function verify(c: CorridorCase, meta: DvnMeta): Promise<void> {
  console.log(`\n${c.name}`);

  const src = getChainRef(c.srcChainId);
  if (!src?.eligible) {
    return check(c.name, false, `source chain ${c.srcChainId} not in the registry / not eligible`);
  }

  const snap = await readSnapshot(c.oft, src);
  const route = snap.routes.find((r) => r.chainKey === c.dstChainKey && r.isActive);
  if (!route) return check(c.name, false, `no active ${c.dstChainKey} route — corridor removed?`);

  const { uln: send, receiveUln: recv } = route;
  if (!send || !recv) {
    // An unreadable ULN is an RPC problem, not a verdict. Say so rather than fail a rule.
    return check(c.name, false, `ULN unreadable (send=${!!send} receive=${!!recv}) — RPC problem, not a rule break`);
  }

  const sendReq = send.requiredDVNs.map((a) => resolveDvn(a, c.srcChainKey, meta));
  const sendOpt = send.optionalDVNs.map((a) => resolveDvn(a, c.srcChainKey, meta));
  const recvReq = recv.requiredDVNs.map((a) => resolveDvn(a, c.dstChainKey, meta));
  const recvOpt = recv.optionalDVNs.map((a) => resolveDvn(a, c.dstChainKey, meta));
  const e = c.expect;

  // The identity layer. The same operator has a different address on every chain, so a raw
  // address diff reports a mismatch between a DVN and itself — which is how the engine
  // talked itself into believing this corridor was broken.
  if (e.sharedOperatorAcrossChains) {
    const op = e.sharedOperatorAcrossChains;
    check(
      `"${op}" resolves to the same operator on both chains, from different addresses`,
      sendReq.includes(op) && recvReq.includes(op),
      `send=[${sendReq.join(", ")}] receive=[${recvReq.join(", ")}]`,
    );
  }

  // Security lives on the receive side: the quorum that ACCEPTS is the one an attacker
  // must defeat.
  if (e.receiveEffectiveDvns !== undefined) {
    const eff = effectiveDvns(recv);
    check(
      `receive-side effective DVN count is ${e.receiveEffectiveDvns}`,
      eff === e.receiveEffectiveDvns,
      `${recv.requiredDVNCount} required + ${recv.optionalDVNThreshold}-of-${recv.optionalDVNCount} optional = ${eff}`,
    );
  }

  // Deliverability is a subset test: does the sender pay for everything the receiver wants?
  if (e.blocked !== undefined) {
    const d = assessDeliverability(sendReq, sendOpt, recvReq, recvOpt, recv.optionalDVNThreshold);
    check(
      e.blocked ? "corridor IS blocked" : "corridor is NOT blocked — the sender pays for everything the receiver requires",
      d.blocked === e.blocked,
      d.blocked
        ? `missing=[${d.missingRequired.join(", ")}] optionalShortfall=${d.optionalShortfall}`
        : `non-blocking; sender additionally pays [${d.overpaid.join(", ") || "nothing"}] that the receiver ignores`,
    );
  }

  // Whether value can move at all — the thing that makes the config worth scoring.
  if (e.liveness) {
    check(
      `corridor liveness is ${e.liveness} (quoteSend)`,
      route.liveness === e.liveness,
      `liveness=${route.liveness}`,
    );
  }

  const { findings, riskLevel } = await assessSnapshot(snap);
  const onRoute = findings.filter((f) => f.detail.startsWith(`${route.chainName}:`));

  if (e.noUndeliverableFinding) {
    check(
      "engine emits NO 'Undeliverable Route' finding on this corridor",
      !onRoute.some((f) => f.check === "Undeliverable Route"),
      onRoute.map((f) => `[${f.severity}] ${f.check}`).join(" | ") || "no findings on this corridor",
    );
  }
  if (e.noCritical) {
    check(
      "engine emits NO CRITICAL on this corridor",
      !onRoute.some((f) => f.severity === "CRITICAL"),
      `riskLevel=${riskLevel}`,
    );
  }
}

async function main(): Promise<void> {
  const cases = loadCases();
  if (!cases.length) return;

  const meta = await loadDvnMeta();
  for (const c of cases) await verify(c, meta);

  console.log(failures === 0 ? "\nall corridor invariants hold" : `\n${failures} invariant(s) BROKEN`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
