// One-off, read-only capture: USDT0's LayerZero config on X Layer, submitted to
// the public /validate endpoint. Produces the receipt cited in the OKX.AI
// submission — the settlement asset of OKX's agent marketplace, validated by
// the same rule engine agents call through ASP #6455.
//
// Reads use the same selectors and ULN decoder as the monitoring path
// (lz-config.ts), over the committed chain registry's public RPCs. No writes,
// no keys, no prod state touched. Run: npx tsx src/scripts/capture-usdt0-xlayer.ts
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SEL, ENDPOINT, decodeUlnConfig } from "../services/lz-config.js";

const MESH_URL = "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list?symbols=USDT0";
const VALIDATE_URL = process.env.VALIDATE_URL ?? "https://backend-production-d16e.up.railway.app/api/sentinel/validate";
const OUT_DIR = process.env.RECEIPT_DIR ?? "/Users/Admin/Desktop/oft-audit-product/grants/okx";

const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const padAddr = (a: string) => pad(a.toLowerCase());
const padU32 = (n: number) => n.toString(16).padStart(64, "0");
const addrOf = (word: string) => "0x" + word.slice(-40);

interface RegistryChain { chainKey: string; eid: number; chainId: number; rpcs: { url: string }[] }
const registry: Record<string, RegistryChain> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "chain-registry.json"), "utf8"),
).chains;

async function rpcCall(chain: RegistryChain, method: string, params: unknown[]): Promise<string | null> {
  for (const { url } of chain.rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      const j = (await res.json()) as { result?: string; error?: unknown };
      if (typeof j.result === "string") return j.result;
    } catch { /* next rpc */ }
  }
  return null;
}

const ethCall = (chain: RegistryChain, to: string, data: string) =>
  rpcCall(chain, "eth_call", [{ to, data }, "latest"]);

async function main() {
  const mesh = (await (await fetch(MESH_URL)).json()).USDT0[0];
  const xl = registry.xlayer;
  const adapter: string = mesh.deployments.xlayer.address;
  const provenance: Record<string, string> = {};

  for (const key of ["xlayer", ...Object.keys(mesh.deployments)]) {
    const c = registry[key];
    if (c && !provenance[key]) provenance[key] = `block ${parseInt((await rpcCall(c, "eth_blockNumber", [])) ?? "0x0", 16)}`;
  }

  const ownerWord = await ethCall(xl, adapter, SEL.owner);
  const owner = ownerWord ? addrOf(ownerWord) : null;
  const ownerCode = owner ? await rpcCall(xl, "eth_getCode", [owner, "latest"]) : null;

  const routes = [];
  for (const [chainKey, dep] of Object.entries<Record<string, unknown>>(mesh.deployments)) {
    if (chainKey === "xlayer") continue;
    const remote = registry[chainKey];
    if (!remote) { console.error(`skip ${chainKey}: not in chain registry`); continue; }

    const peerWord = await ethCall(xl, adapter, SEL.peers + padU32(remote.eid));
    const peer = peerWord && BigInt(peerWord) !== 0n ? addrOf(peerWord) : null;
    if (!peer) { console.error(`skip ${chainKey}: no peer set`); continue; }

    const sendLibWord = await ethCall(xl, ENDPOINT, SEL.getSendLibrary + padAddr(adapter) + padU32(remote.eid));
    const sendLibrary = sendLibWord ? addrOf(sendLibWord) : null;
    const isDefWord = await ethCall(xl, ENDPOINT, SEL.isDefaultSendLibrary + padAddr(adapter) + padU32(remote.eid));
    const recvLibRaw = await ethCall(xl, ENDPOINT, SEL.getReceiveLibrary + padAddr(adapter) + padU32(remote.eid));
    const enfRaw = await ethCall(xl, adapter, SEL.enforcedOptions + padU32(remote.eid) + padU32(1));
    const ulnRaw = sendLibrary
      ? await ethCall(xl, ENDPOINT, SEL.getConfig + padAddr(adapter) + padAddr(sendLibrary) + padU32(remote.eid) + padU32(2))
      : null;

    // Destination side: the remote chain's receive library + ULN for messages FROM X Layer.
    const remoteOft = dep.address as string;
    let receiveUln = null;
    try {
      const rRecvRaw = await ethCall(remote, ENDPOINT, SEL.getReceiveLibrary + padAddr(remoteOft) + padU32(xl.eid));
      const rRecvLib = rRecvRaw ? addrOf(rRecvRaw.slice(0, 66)) : null;
      if (rRecvLib) {
        const rUlnRaw = await ethCall(remote, ENDPOINT, SEL.getConfig + padAddr(remoteOft) + padAddr(rRecvLib) + padU32(xl.eid) + padU32(2));
        receiveUln = rUlnRaw ? decodeUlnConfig(rUlnRaw) : null;
      }
    } catch { /* stays null — reads as unverifiable, never guessed */ }

    routes.push({
      eid: remote.eid,
      chainName: chainKey,
      chainKey,
      sendLibrary,
      sendLibIsDefault: isDefWord ? BigInt(isDefWord) !== 0n : null,
      receiveLibrary: recvLibRaw ? addrOf(recvLibRaw.slice(0, 66)) : null,
      receiveLibIsDefault: recvLibRaw ? BigInt("0x" + recvLibRaw.slice(66, 130)) !== 0n : null,
      uln: ulnRaw ? decodeUlnConfig(ulnRaw) : null,
      receiveUln,
      peer,
      peerAddress: peer,
      hasEnforcedOptions: enfRaw ? enfRaw.length > 130 && BigInt("0x" + enfRaw.slice(66, 130)) !== 0n : null,
      isActive: true,
    });
    console.error(`${chainKey}: peer ✓ sendLib ${sendLibrary ? "✓" : "∅"} uln ${ulnRaw ? "✓" : "∅"} recvUln ${receiveUln ? "✓" : "∅"}`);
  }

  const snapshot = {
    oft: adapter,
    chainId: xl.chainId,
    capturedAt: Date.now(),
    owner,
    ownerIsContract: ownerCode ? ownerCode !== "0x" : null,
    routes,
  };

  const res = await fetch(VALIDATE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot, ticker: "USDT0" }),
  });
  const verdict = await res.json();

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `usdt0-xlayer-validate-receipt-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify({
    capturedAt: new Date().toISOString(),
    subject: "USDT0 (X Layer adapter) — settlement asset of OKX.AI x402 payments",
    adapter, innerToken: mesh.deployments.xlayer.innerTokenAddress,
    endpoint: VALIDATE_URL, blockProvenance: provenance,
    request: { snapshot, ticker: "USDT0" }, httpStatus: res.status, verdict,
  }, null, 2));
  console.error(`receipt → ${out}`);
  console.log(JSON.stringify({ status: res.status, score: verdict.score, riskLevel: verdict.riskLevel, findings: verdict.findings?.length, rulesVersion: verdict.rulesVersion }));
}

main().catch((e) => { console.error(e); process.exit(1); });
