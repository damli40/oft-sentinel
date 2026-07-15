/**
 * disclosure-digest — disclosure gate for the partner findings channel.
 *
 * Safety class: `list` and `check` are read-only; `mark` and `status` write ONLY the
 * local disclosure-log.json (DATA_DIR). Nothing here touches a chain, an RPC, or
 * Telegram — this is bookkeeping for what has already been disclosed.
 *
 * Workflow (before every digest):
 *   1. cd backend && SCAN_OUT=/tmp/scan.ndjson npx tsx src/scripts/scan-readonly.ts
 *   2. npx tsx src/scripts/disclosure-digest.ts check --scan /tmp/scan.ndjson
 *        → prints SEND (new/escalated) vs SUPPRESSED; only SEND items belong in the digest
 *   3. write + send the digest (human step, sentiment-tested per standing rules)
 *   4. npx tsx src/scripts/disclosure-digest.ts mark --scan /tmp/scan.ndjson --digest <id>
 *        → records exactly the SEND set as sent under that digest id
 *
 * Lifecycle fixes:
 *   npx tsx src/scripts/disclosure-digest.ts status <chainId> <oft> <check...> --set acked|withdrawn|superseded [--note "..."]
 *   npx tsx src/scripts/disclosure-digest.ts list
 *
 * The log file is confidential (real tickers/addresses) and lives in gitignored
 * backend/data/ — same confidentiality boundary as corridor-invariants.json.
 */
import { readFileSync } from "node:fs";
import {
  loadDisclosureLog,
  decideDigest,
  recordSent,
  setStatus,
  disclosureLogFile,
  type DigestCandidate,
  type SentStatus,
} from "../services/disclosure-log.js";
import type { Severity } from "../types.js";

interface ScanRow {
  kind?: string;
  ticker: string;
  address: string;
  chainId: number;
  findings?: { severity: Severity; check: string; detail: string }[];
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  disclosure-digest.ts list",
      "  disclosure-digest.ts check --scan <scan.ndjson>",
      "  disclosure-digest.ts mark  --scan <scan.ndjson> --digest <digest-id> [--date YYYY-MM-DD]",
      "  disclosure-digest.ts status <chainId> <oft> <check words...> --set <acked|superseded|withdrawn> [--note <text>]",
    ].join("\n"),
  );
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** scan-readonly rows → digest candidates (non-PASS findings only). */
function candidatesFromScan(path: string): DigestCandidate[] {
  const out: DigestCandidate[] = [];
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    let row: ScanRow;
    try {
      row = JSON.parse(line) as ScanRow;
    } catch {
      continue;
    }
    if (row.kind && row.kind !== "row") continue;
    for (const f of row.findings ?? []) {
      if (f.severity === "PASS") continue;
      out.push({
        oft: row.address,
        chainId: row.chainId,
        ticker: row.ticker,
        check: f.check,
        severity: f.severity,
        detail: f.detail,
      });
    }
  }
  return out;
}

function fmt(c: DigestCandidate): string {
  return `${c.severity.padEnd(8)} ${c.ticker.padEnd(10)} chain ${String(c.chainId).padEnd(6)} ${c.check.padEnd(24)} ${c.oft}`;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") {
  const log = loadDisclosureLog();
  console.log(`# ${log.length} entr${log.length === 1 ? "y" : "ies"} in ${disclosureLogFile()}\n`);
  for (const e of log) {
    console.log(
      `${e.status.padEnd(11)} ${e.severity.padEnd(8)} ${e.ticker.padEnd(10)} chain ${String(e.chainId).padEnd(6)} ${e.check.padEnd(24)} ${e.digestId} (${e.sentAt})${e.note ? ` — ${e.note}` : ""}`,
    );
  }
} else if (cmd === "check" || cmd === "mark") {
  const scanPath = flag(args, "--scan");
  if (!scanPath) usage();
  const log = loadDisclosureLog();
  // An empty log turns every finding into "new" — say so before anyone trusts the output.
  console.log(`# ${log.length} previously sent entr${log.length === 1 ? "y" : "ies"} on file (${disclosureLogFile()})`);
  if (log.length === 0) {
    console.log("# ⚠️  empty log: if findings HAVE been sent before, seed the log first — everything below will look new");
  }

  const decisions = decideDigest(candidatesFromScan(scanPath));
  const send = decisions.filter((d) => d.action === "send");
  const suppressed = decisions.filter((d) => d.action === "suppress" && d.reason !== "pass");
  const review = suppressed.filter((d) => d.reason === "withdrawn" || d.reason === "superseded");

  console.log(`\n## SEND — ${send.length} finding(s) eligible for the next digest`);
  for (const d of send) console.log(`  [${d.reason.toUpperCase().padEnd(9)}] ${fmt(d.candidate)}`);

  console.log(`\n## SUPPRESSED — ${suppressed.length} already disclosed`);
  for (const d of suppressed) console.log(`  [${d.reason.padEnd(12)}] ${fmt(d.candidate)}`);

  if (review.length) {
    console.log(`\n## ⚠️  NEEDS HUMAN REVIEW — ${review.length} withdrawn/superseded finding(s) still firing`);
    console.log("#  the engine still reports these; either the retraction was wrong or the rule still is.");
    console.log("#  never auto-resend — clear the status explicitly if re-disclosure is intended.");
  }

  if (cmd === "mark") {
    const digestId = flag(args, "--digest");
    if (!digestId) usage();
    const date = flag(args, "--date");
    recordSent(send.map((d) => d.candidate), digestId, date);
    console.log(`\n✓ marked ${send.length} finding(s) as sent in ${digestId}`);
  }
} else if (cmd === "status") {
  const setIdx = args.indexOf("--set");
  if (setIdx < 0 || args.length < 4) usage();
  const positional = args.slice(0, setIdx);
  const [chainIdRaw, oft, ...checkWords] = positional;
  const chainId = Number(chainIdRaw);
  const check = checkWords.join(" ");
  const status = flag(args, "--set") as SentStatus;
  const note = flag(args, "--note");
  if (!chainId || !oft || !check || !["acked", "superseded", "withdrawn", "sent"].includes(status)) usage();
  if (setStatus(oft, chainId, check, status, note)) {
    console.log(`✓ ${chainId}:${oft}:${check} → ${status}${note ? ` (${note})` : ""}`);
  } else {
    console.error(`✗ no entry for ${chainId}:${oft}:${check}`);
    process.exit(1);
  }
} else {
  usage();
}
