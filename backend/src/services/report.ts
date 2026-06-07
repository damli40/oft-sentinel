import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { OftSnapshot, RouteSnapshot, Finding } from "../types.js";
import { assessSnapshot } from "./drift.js";
import { loadDvnMeta, resolveDvn, isDvnDeprecated } from "./lz-config.js";
import { getSnapshot, latestVerdict } from "./snapshot-store.js";
import type { WatchedOft } from "../types.js";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const SEPOLIA = "https://sepolia.mantlescan.xyz";

const REFERENCE = (() => {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(dir, "oft-security-reference.md"), "utf8");
  } catch {
    return "";
  }
})();

// ── LLM narrative ────────────────────────────────────────────────────────────
interface Narrative {
  summary: string;
  trustAssumptions: string[];
  recommendations: string[];
}

async function writeNarrative(facts: unknown): Promise<Narrative> {
  const fallback = (): Narrative => ({
    summary: "Automated assessment generated from live on-chain DVN configuration. See findings and corridor tables below.",
    trustAssumptions: ["Message security depends on the honesty and liveness of the required DVNs listed per corridor."],
    recommendations: ["Review any CRITICAL/HIGH findings above; prefer ≥3 independent required DVNs and pinned message libraries."],
  });
  if (!DEEPSEEK_KEY) return fallback();

  const system = REFERENCE
    ? `${REFERENCE}\n\n---\nYou are acting as the OFT Sentinel narrative engine. Follow all rules in the reference above exactly.`
    : "You are an OFT (LayerZero omnichain token) security auditor. Given structured on-chain facts, write the NARRATIVE sections of a security report. " +
      "Be precise and grounded ONLY in the facts provided — do not invent DVN names, counts, or addresses. " +
      'Respond with a single JSON code block: {"summary": string (2-4 sentences), "trustAssumptions": string[] (3-5 items), "recommendations": string[] (2-5 items, concrete)}.';

  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Facts:\n```json\n" + JSON.stringify(facts, null, 2) + "\n```" },
        ],
      }),
    });
    if (!res.ok) return fallback();
    const j = (await res.json()) as any;
    const content: string = j.choices?.[0]?.message?.content ?? "";
    const block = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const parsed = JSON.parse(block ? block[1] : content);
    return {
      summary: String(parsed.summary ?? fallback().summary),
      trustAssumptions: Array.isArray(parsed.trustAssumptions) ? parsed.trustAssumptions.map(String) : fallback().trustAssumptions,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : fallback().recommendations,
    };
  } catch {
    return fallback();
  }
}

// ── Markdown rendering (deterministic data + LLM narrative) ──────────────────
function findingsTable(findings: Finding[]): string {
  if (!findings.length) return "_No findings — configuration looks healthy._";
  const rows = findings.map((f) => `| ${f.severity} | ${f.check} | ${f.detail.replace(/\|/g, "\\|")} |`).join("\n");
  return `| Severity | Check | Detail |\n|---|---|---|\n${rows}`;
}

function corridorTable(routes: RouteSnapshot[], meta: Awaited<ReturnType<typeof loadDvnMeta>>, srcChainKey: string): string {
  const active = routes.filter((r) => r.isActive && r.uln);
  if (!active.length) return "_No active corridors with a readable ULN config._";
  const rows = active
    .map((r) => {
      // DVNs live on the source chain (Mantle) — resolve names against srcChainKey ("mantle")
      const label = (addr: string) => {
        const name = resolveDvn(addr, srcChainKey, meta);
        return isDvnDeprecated(addr, srcChainKey, meta) ? `${name} ⚠️deprecated` : name;
      };
      const req = r.uln!.requiredDVNs.map(label).join(", ") || "—";
      const opt = r.uln!.optionalDVNs.length ? ` (+${r.uln!.optionalDVNThreshold}/${r.uln!.optionalDVNCount} optional)` : "";
      const lib = r.sendLibIsDefault ? "default ⚠️" : "pinned";
      return `| ${r.chainName} | ${r.uln!.requiredDVNCount}-of-${r.uln!.requiredDVNCount}${opt} | ${req} | ${r.uln!.confirmations} | ${lib} |`;
    })
    .join("\n");
  return `| Corridor | Required DVNs | DVN set | Confirmations | Send lib |\n|---|---|---|---|---|\n${rows}`;
}

const cache = new Map<string, { at: number; markdown: string }>();

/** Generate (or return cached) a full markdown audit report for one watched OFT. */
export async function generateReport(w: WatchedOft): Promise<string | null> {
  const snap = getSnapshot(w.address, w.chainId);
  if (!snap) return null; // not polled yet

  const cacheKey = `${w.address.toLowerCase()}:${snap.capturedAt}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit.markdown;

  const dvnMeta = await loadDvnMeta();
  const srcChainKey = "mantle"; // DVN metadata is keyed by chainKey, not numeric chain ID
  const { findings, score, riskLevel } = await assessSnapshot(snap, w.ticker);
  const verdict = latestVerdict(w.address, w.chainId);

  const facts = {
    ticker: w.ticker,
    address: w.address,
    chain: "Mantle",
    score,
    riskLevel,
    ownerIsContract: snap.ownerIsContract,
    proxyAdmin: snap.proxyAdmin,
    proxyAdminIsMultisig: snap.proxyAdminIsMultisig,
    findings,
    corridors: snap.routes
      .filter((r) => r.isActive && r.uln)
      .map((r) => ({
        corridor: r.chainName,
        requiredDVNCount: r.uln!.requiredDVNCount,
        requiredDVNs: r.uln!.requiredDVNs.map((a) => resolveDvn(a, srcChainKey, dvnMeta)),
        confirmations: r.uln!.confirmations,
        sendLibDefault: r.sendLibIsDefault,
      })),
  };

  const narrative = await writeNarrative(facts);
  const generated = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const md = `# OFT Sentinel — ${w.ticker} security report

**${w.address}** · Mantle · generated ${generated}
**Score ${score}/100 · ${riskLevel}**

## Summary

${narrative.summary}

## Findings

${findingsTable(findings)}

## DVN configuration by corridor

${corridorTable(snap.routes, dvnMeta, srcChainKey)}

${snap.owner ? `**Owner:** \`${snap.owner}\` (${snap.ownerIsContract ? "contract" : "EOA"})\n` : ""}
## Trust assumptions

${narrative.trustAssumptions.map((t) => `- ${t}`).join("\n")}

## Recommendations

${narrative.recommendations.map((r) => `- ${r}`).join("\n")}

## On-chain

${
  verdict?.attestTxHash
    ? `- Latest drift attestation: [${verdict.attestTxHash.slice(0, 14)}…](${SEPOLIA}/tx/${verdict.attestTxHash}) (AuditRegistry, Mantle Sepolia)`
    : "- No drift attestations for this OFT yet — monitored continuously by OFT Sentinel."
}

---
*Generated by OFT Sentinel — deterministic on-chain DVN reads with an LLM-written narrative. Not financial advice.*
`;

  cache.set(cacheKey, { at: Date.now(), markdown: md });
  return md;
}
