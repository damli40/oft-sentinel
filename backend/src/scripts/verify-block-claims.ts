/**
 * verify-block-claims.ts — the UNTESTED discriminator (safety class: writes-disk).
 *
 * For corridors that already carry a block-class finding, answers: was the CURRENT
 * send-ULN config already in force at the block of the last DELIVERED message?
 * If not, every delivery the nonce accounting sees predates the config we score —
 * history that must never soften a block claim (the stale-evidence lesson).
 *
 * Method per corridor (never fleet-wide — run it on the handful that need it):
 *   1. LayerZero Scan API (public, keyless): all outbound messages for (srcEid, oft),
 *      filtered to the destination eid. Gives per-message status + send block, and
 *      dates every undelivered message (stranded vs in-flight) as a side product.
 *   2. One archival eth_call pair on the source chain: getSendLibrary + getConfig(ULN)
 *      at the last delivered message's block, compared against the same reads at
 *      latest. Tries every registry RPC until one serves archive state.
 *   3. Records the verdict in DATA_DIR/block-claim-verifications.json (gitignored),
 *      which readSnapshot stamps onto route.delivery.sentUnderCurrentConfig.
 *
 * Usage:
 *   npx tsx src/scripts/verify-block-claims.ts --scan /tmp/scan.ndjson [--dry-run]
 *   npx tsx src/scripts/verify-block-claims.ts --oft 0x… --chain 8453 --dst bsc [--dry-run]
 *
 * On-chain: eth_call only. Writes: the local worksheet. No alerts, no attestations.
 */
import { readFileSync } from "fs";
import { encodeFunctionData, pad } from "viem";
import { getChainRef, getChainRefByKey } from "../services/chain-registry.js";
import { ENDPOINT, SEL, decodeUlnConfig } from "../services/lz-config.js";
import {
  recordBlockClaimVerification, ulnFingerprint, blockClaimVerificationsFile,
} from "../services/block-claim-verifications.js";
import type { ChainRef, UlnSnapshot } from "../types.js";

// Check names that assert "messages do not get through" — the only findings whose
// delivery evidence this discriminator informs. Legacy names included so old scan
// files (rules ≤4.0.0) still select the right corridors.
const BLOCK_CLASS = new Set([
  "Block Confirmation Mismatch",
  "Confirmation Mismatch",     // ≤4.0.0 name
  "Confirmation Asymmetry",    // interim (never shipped) name
  "Undeliverable Route",
  "Half-Wired Corridor",
  "Dead Receive DVN",
]);

const SCAN_API = "https://scan.layerzero-api.com/v1";

// ── tiny hex/eth_call helpers (script-local; selectors come from lz-config's table) ──
const strip0x = (s: string) => (s.startsWith("0x") ? s.slice(2) : s);
const padAddr = (a: string) => strip0x(a).toLowerCase().padStart(64, "0");
const padU32 = (n: number) => n.toString(16).padStart(64, "0");

async function ethCall(rpc: string, to: string, data: string, blockTag: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, blockTag] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { result?: string; error?: { message?: string } };
  if (j.error || typeof j.result !== "string") throw new Error(j.error?.message ?? "no result");
  return j.result;
}

/** Try every registry RPC until one answers — archive access is uneven on free tiers. */
async function callAnyRpc(chain: ChainRef, to: string, data: string, blockTag: string): Promise<{ result: string; rpc: string }> {
  let lastErr: unknown;
  for (const r of chain.rpcs) {
    try {
      return { result: await ethCall(r.url, to, data, blockTag), rpc: r.provider };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`no RPC on ${chain.chainKey} served ${blockTag}: ${(lastErr as Error)?.message}`);
}

async function readSendUln(chain: ChainRef, oft: string, dstEid: number, blockTag: string): Promise<{ uln: UlnSnapshot | null; rpc: string }> {
  const lib = await callAnyRpc(chain, ENDPOINT, SEL.getSendLibrary + padAddr(oft) + padU32(dstEid), blockTag);
  const libAddr = "0x" + strip0x(lib.result).slice(-40);
  const cfg = await callAnyRpc(chain, ENDPOINT, SEL.getConfig + padAddr(oft) + padAddr(libAddr) + padU32(dstEid) + padU32(2), blockTag);
  return { uln: decodeUlnConfig(cfg.result), rpc: cfg.rpc };
}

// ── LayerZero Scan messages for one pathway ──────────────────────────────────
interface ScanMsg {
  pathway: { srcEid: number; dstEid: number; nonce: number; sender: { address: string } };
  status: { name: string };
  source: { tx: { txHash: string; blockTimestamp: number; blockNumber?: number | string } };
}

async function fetchPathwayMessages(srcEid: number, oft: string, dstEid: number): Promise<ScanMsg[]> {
  const out: ScanMsg[] = [];
  let token: string | undefined;
  for (let page = 0; page < 40; page++) {
    const url = `${SCAN_API}/messages/oapp/${srcEid}/${oft}?limit=100${token ? `&nextToken=${token}` : ""}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`scan API HTTP ${res.status}`);
    const d = (await res.json()) as { data?: ScanMsg[]; nextToken?: string };
    out.push(...(d.data ?? []));
    token = d.nextToken;
    if (!token) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out.filter(
    (m) => m.pathway.srcEid === srcEid && m.pathway.dstEid === dstEid &&
           m.pathway.sender.address.toLowerCase() === oft.toLowerCase(),
  );
}

async function txBlockNumber(chain: ChainRef, txHash: string): Promise<number> {
  for (const r of chain.rpcs) {
    try {
      const res = await fetch(r.url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      });
      const j = (await res.json()) as { result?: { blockNumber?: string } };
      if (j.result?.blockNumber) return Number(BigInt(j.result.blockNumber));
    } catch { /* next rpc */ }
  }
  throw new Error(`no RPC returned receipt for ${txHash}`);
}

const days = (ts: number) => ((Date.now() / 1000 - ts) / 86400).toFixed(1);

// ── corridor selection ────────────────────────────────────────────────────────
interface Corridor { oft: string; chainId: number; dstKey: string; checks: string[] }

function corridorsFromScan(file: string): Corridor[] {
  const byKey = new Map<string, Corridor>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.kind !== "row" || !Array.isArray(row.findings)) continue;
    for (const f of row.findings) {
      if (!BLOCK_CLASS.has(f.check)) continue;
      // detail format: "<dstChainKey>: …" — the corridor the finding is about
      const dstKey = String(f.detail ?? "").split(":")[0]?.trim();
      if (!dstKey || !getChainRefByKey(dstKey)) continue;
      const k = `${row.chainId}:${row.address.toLowerCase()}:${dstKey}`;
      const c: Corridor = byKey.get(k) ?? { oft: row.address, chainId: row.chainId, dstKey, checks: [] };
      if (!c.checks.includes(f.check)) c.checks.push(f.check);
      byKey.set(k, c);
    }
  }
  return [...byKey.values()];
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const dryRun = args.includes("--dry-run");

  let corridors: Corridor[];
  const scanFile = opt("--scan");
  if (scanFile) {
    corridors = corridorsFromScan(scanFile);
  } else {
    const oft = opt("--oft"), chain = opt("--chain"), dst = opt("--dst");
    if (!oft || !chain || !dst) {
      console.error("usage: --scan <ndjson> | --oft <addr> --chain <chainId> --dst <chainKey>  [--dry-run]");
      process.exit(1);
    }
    corridors = [{ oft, chainId: Number(chain), dstKey: dst, checks: ["(manual)"] }];
  }

  if (corridors.length === 0) {
    console.log("no corridors with block-class findings in the scan — nothing to verify");
    return;
  }
  console.log(`${corridors.length} corridor(s) to verify → ${dryRun ? "(dry-run, not writing)" : blockClaimVerificationsFile()}\n`);

  for (const c of corridors) {
    const src = getChainRef(c.chainId);
    const dst = getChainRefByKey(c.dstKey);
    const label = `${c.oft} ${src?.chainKey ?? c.chainId}→${c.dstKey}`;
    if (!src || !dst) { console.log(`✗ ${label}: unknown chain — skipped`); continue; }

    try {
      const msgs = await fetchPathwayMessages(src.eid, c.oft, dst.eid);
      const deliveredMsgs = msgs.filter((m) => m.status.name === "DELIVERED").sort((a, b) => a.pathway.nonce - b.pathway.nonce);
      const undelivered = msgs.filter((m) => m.status.name !== "DELIVERED").sort((a, b) => a.pathway.nonce - b.pathway.nonce);

      console.log(`── ${label}  [${c.checks.join(", ")}]`);
      console.log(`   scan: ${msgs.length} messages · ${deliveredMsgs.length} delivered · ${undelivered.length} undelivered`);
      for (const m of undelivered) {
        console.log(`   ⚠ ${m.status.name} nonce ${m.pathway.nonce} sent ${new Date(m.source.tx.blockTimestamp * 1000).toISOString().slice(0, 16)} (${days(m.source.tx.blockTimestamp)}d ago) tx ${m.source.tx.txHash}`);
      }

      if (deliveredMsgs.length === 0) {
        console.log(`   → nothing ever delivered: no history to discriminate (UNUSED/STRANDING already say it)\n`);
        continue;
      }

      const last = deliveredMsgs[deliveredMsgs.length - 1];
      const block = last.source.tx.blockNumber != null
        ? Number(last.source.tx.blockNumber)
        : await txBlockNumber(src, last.source.tx.txHash);

      const now = await readSendUln(src, c.oft, dst.eid, "latest");
      const then = await readSendUln(src, c.oft, dst.eid, "0x" + block.toString(16));
      if (!now.uln || !then.uln) {
        console.log(`   ✗ could not decode ULN config (now: ${!!now.uln}, at block ${block}: ${!!then.uln}) — not recorded\n`);
        continue;
      }

      const same = ulnFingerprint(now.uln) === ulnFingerprint(then.uln);
      console.log(`   last delivered: nonce ${last.pathway.nonce} @ block ${block} (${days(last.source.tx.blockTimestamp)}d ago)`);
      console.log(`   send-ULN then (via ${then.rpc}): confs ${then.uln.confirmations}, ${then.uln.requiredDVNs.length} required DVN(s)`);
      console.log(`   send-ULN now  (via ${now.rpc}): confs ${now.uln.confirmations}, ${now.uln.requiredDVNs.length} required DVN(s)`);
      console.log(`   → sentUnderCurrentConfig: ${same} ${same ? "(history crossed under the scored config)" : "(ALL delivery history predates the current config — UNTESTED)"}`);

      if (!dryRun) {
        recordBlockClaimVerification(c.chainId, c.oft, dst.eid, {
          sentUnderCurrentConfig: same,
          lastDeliveredBlock: block,
          // deliveredAtVerification uses the live inboundNonce the snapshot layer also
          // reads; Scan's DELIVERED count can lag it, so read it directly from the dest.
          deliveredAtVerification: await inboundNonce(src, dst, c.oft),
          sendUlnFingerprint: ulnFingerprint(now.uln),
          verifiedAt: Date.now(),
          note: `last delivered nonce ${last.pathway.nonce} @ src block ${block}; archive via ${then.rpc}`,
        });
        console.log(`   ✓ recorded\n`);
      } else {
        console.log(`   (dry-run: not recorded)\n`);
      }
    } catch (e: any) {
      console.log(`   ✗ ${e.message} — not recorded\n`);
    }
  }
}

/** Live inboundNonce on the destination — the same number readSnapshot's delivery
 *  accounting sees as `delivered`, so the stamp's validity check compares like with like. */
async function inboundNonce(src: ChainRef, dst: ChainRef, oft: string): Promise<number> {
  // peer on the destination = who the OFT's own peers(dstEid) points at (OFT function, not endpoint)
  const peerB32 = await callAnyRpc(src, oft, SEL.peers + padU32(dst.eid), "latest");
  const peer = ("0x" + strip0x(peerB32.result).slice(-40)) as `0x${string}`;
  const data = encodeFunctionData({
    abi: [{ name: "inboundNonce", type: "function", stateMutability: "view",
            inputs: [{ type: "address" }, { type: "uint32" }, { type: "bytes32" }],
            outputs: [{ type: "uint64" }] }],
    functionName: "inboundNonce",
    args: [peer, src.eid, pad(oft as `0x${string}`, { size: 32 })],
  });
  const r = await callAnyRpc(dst, ENDPOINT, data, "latest");
  return Number(BigInt(r.result));
}

main().catch((e) => { console.error(e); process.exit(1); });
