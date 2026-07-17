import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  parseEther,
  getAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RiskLevel, SentinelVerdict } from "../types.js";

// AlertBus.alert(oft, chainId, recipient, score, risk, agentId, verdictURI) payable
const ALERTBUS_ABI = [
  {
    name: "alert",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "oft", type: "address" },
      { name: "chainId", type: "uint32" },
      { name: "recipient", type: "address" },
      { name: "score", type: "uint8" },
      { name: "risk", type: "uint8" },
      { name: "agentId", type: "uint256" },
      { name: "verdictURI", type: "string" },
    ],
    outputs: [],
  },
] as const;

const RISK_ENUM: Record<RiskLevel, number> = { PASS: 1, AT_RISK: 2, CRITICAL: 4 };

const SENTINEL_CHAIN_ID = Number(process.env.SENTINEL_CHAIN_ID ?? 5003);
const SENTINEL_RPC = process.env.SENTINEL_RPC ?? "https://rpc.sepolia.mantle.xyz";
const AGENT_ID = BigInt(process.env.SENTINEL_AGENT_ID ?? 1);
const NUDGE_MNT = "0.0001"; // dust nudge attached to the on-chain alert
const SEPOLIA_EXPLORER = "https://sepolia.mantlescan.xyz";

// Explorer per WATCHED chain — the OFT address link must point at the chain the
// asset lives on. Attestation/AlertBus links always stay on Mantle Sepolia
// (SEPOLIA_EXPLORER): that is where Sentinel's contracts are, whatever the asset's chain.
const CHAIN_EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  8453: "https://basescan.org",
  5000: "https://mantlescan.xyz",
};

/** Address link on the watched chain's explorer; blockscan cross-chain search when unmapped. */
export function oftExplorerUrl(chainId: number, address: string): string {
  const base = CHAIN_EXPLORERS[chainId] ?? "https://blockscan.com";
  return `${base}/address/${address}`;
}

const sentinelChain = defineChain({
  id: SENTINEL_CHAIN_ID,
  name: "Mantle Sepolia",
  nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
  rpcUrls: { default: { http: [SENTINEL_RPC] } },
});

function account() {
  const pk = process.env.SENTINEL_PRIVATE_KEY;
  if (!pk) throw new Error("SENTINEL_PRIVATE_KEY not set");
  return privateKeyToAccount(pk as `0x${string}`);
}

function alertBusAddress(): Address {
  const a = process.env.ALERT_BUS_ADDRESS;
  if (!a) throw new Error("ALERT_BUS_ADDRESS not set");
  return getAddress(a) as Address;
}

/** Fire the on-chain AlertBus event + dust nudge to the OFT owner. */
async function fireOnChainAlert(
  oft: string,
  watchedChainId: number,
  recipient: string,
  score: number,
  risk: RiskLevel,
  verdictURI: string
): Promise<string> {
  const acct = account();
  const wallet = createWalletClient({ account: acct, chain: sentinelChain, transport: http(SENTINEL_RPC) });
  const pub = createPublicClient({ chain: sentinelChain, transport: http(SENTINEL_RPC) });

  const txHash = await wallet.writeContract({
    address: alertBusAddress(),
    abi: ALERTBUS_ABI,
    functionName: "alert",
    args: [getAddress(oft), watchedChainId, getAddress(recipient), score, RISK_ENUM[risk], AGENT_ID, verdictURI],
    value: parseEther(NUDGE_MNT),
  });
  await pub.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseChatList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map((x) => x.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((x) => parseChatList(x));
  }
  return [];
}

export function parseTeamTelegramContacts(raw = process.env.TELEGRAM_TEAM_ALERTS_JSON): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), unique(parseChatList(value))])
    );
  } catch {
    console.error("[alert:telegram] TELEGRAM_TEAM_ALERTS_JSON must be JSON like {\"cmETH\":[\"123\",\"@team\"]}");
    return {};
  }
}

export function telegramRecipients(v: SentinelVerdict): { publicChatId: string | null; teamChatIds: string[] } {
  const contacts = parseTeamTelegramContacts();
  const publicChatId = process.env.TELEGRAM_PUBLIC_ALERT_CHAT_ID ?? process.env.TELEGRAM_ALERT_CHAT_ID ?? null;
  const teamChatIds = unique([
    ...(contacts[v.ticker.toLowerCase()] ?? []),
    ...(contacts[v.oft.toLowerCase()] ?? []),
  ]);
  return { publicChatId, teamChatIds };
}

/** Escape text for Telegram HTML parse_mode (only <, >, & are special). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** <code> address/hash → tap-to-copy in Telegram clients. */
function code(s: string): string {
  return `<code>${esc(s)}</code>`;
}

/** Hyperlink that hides the long explorer URL behind a short label. */
function link(label: string, url: string): string {
  return `<a href="${esc(url)}">${esc(label)}</a>`;
}

export async function sendTelegram(chatId: string | null, text: string, label: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    console.log(`[alert:telegram:${label}:mock] ${text}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch((e) => {
    console.error(`[alert:telegram:${label}] failed:`, e.message);
    return null;
  });
  if (res && !res.ok) {
    console.error(`[alert:telegram:${label}] failed ${res.status}:`, await res.text());
  }
}

function postX(text: string): void {
  // X posting is mocked for the demo — logged, not sent.
  console.log(`[alert:x:mock] ${text}`);
}

/**
 * Tiered escalation. AT_RISK → on-chain AlertBus + Telegram (private). CRITICAL →
 * also a public X post. The OFT owner receives the dust MNT nudge so the warning
 * shows up in their wallet activity. Recipient falls back to the Sentinel signer
 * when the owner can't be resolved (the contract requires a non-zero recipient).
 */
export async function dispatchAlert(
  v: SentinelVerdict,
  ownerRecipient: string | null
): Promise<string | undefined> {
  if (v.riskLevel === "PASS") return undefined;

  const recipient = ownerRecipient ?? account().address;
  const verdictURI = v.attestationId !== undefined ? `attestation:${v.attestationId}` : "";

  let alertTxHash: string | undefined;
  try {
    alertTxHash = await fireOnChainAlert(v.oft, v.chainId, recipient, v.score, v.riskLevel, verdictURI);
  } catch (e: any) {
    console.error("[alert] on-chain AlertBus failed:", e.shortMessage ?? e.message);
  }

  const txLine = alertTxHash
    ? `AlertBus: ${link(alertTxHash.slice(0, 10) + "…", `${SEPOLIA_EXPLORER}/tx/${alertTxHash}`)}`
    : "AlertBus: unavailable";
  const attestationLine = v.attestTxHash
    ? `Attestation: ${link(v.attestTxHash.slice(0, 10) + "…", `${SEPOLIA_EXPLORER}/tx/${v.attestTxHash}`)}`
    : "Attestation: unavailable";
  const reasons = esc(v.reasons.length ? v.reasons.join("; ") : v.verdict);
  const ticker = esc(v.ticker);
  const emoji = v.riskLevel === "CRITICAL" ? "🚨" : "⚠️";
  const remediationBlock = v.tis && v.tis.length > 0
    ? `<blockquote expandable>` +
        v.tis.slice(0, 3).map((t, i) =>
          esc(`${i + 1}. [${t.severity}] ${t.action}${t.corridors?.length ? ` (${t.corridors.join(", ")})` : ""}`)
        ).join("\n") +
        `</blockquote>`
    : null;

  // Public CRITICAL gets a spaced, divider-sectioned layout; other severities stay compact.
  const DIV = "──────────────";
  const criticalPublicMessage = [
    `🚨 <b>OFT SENTINEL — CRITICAL</b>`,
    ``,
    `<b>${ticker}</b>  ·  Score <b>${v.score}/100</b>`,
    ``,
    DIV,
    `📋 <b>Reason</b>`,
    reasons,
    ``,
    DIV,
    `🔗 <b>On-chain</b>`,
    `${link("OFT ↗", oftExplorerUrl(v.chainId, v.oft))}  ·  ${
      v.attestTxHash ? link("Attestation ↗", `${SEPOLIA_EXPLORER}/tx/${v.attestTxHash}`) : "Attestation unavailable"
    }`,
    alertTxHash ? link("AlertBus ↗", `${SEPOLIA_EXPLORER}/tx/${alertTxHash}`) : "AlertBus unavailable",
    ``,
    DIV,
    `🛠 <b>Remediation</b>`,
    remediationBlock ?? "No automated remediation available.",
  ].join("\n");
  const compactPublicMessage = [
    `${emoji} <b>OFT SENTINEL ALERT</b>`,
    `<b>${v.riskLevel}: ${ticker}</b>`,
    ``,
    `Score: <b>${v.score}/100</b>`,
    `Reason: ${reasons}`,
    ``,
    `OFT: ${link(v.oft, oftExplorerUrl(v.chainId, v.oft))}`,
    attestationLine,
    txLine,
  ].join("\n");
  const publicMessage = v.riskLevel === "CRITICAL" ? criticalPublicMessage : compactPublicMessage;
  const tisLines = remediationBlock ? [``, `<b>Remediation</b>`, remediationBlock] : [];
  const teamMessage = [
    `${emoji} <b>Action needed: ${ticker} drift detected</b>`,
    ``,
    `Risk: <b>${v.riskLevel}</b>`,
    `Score: <b>${v.score}/100</b>`,
    `Reason: ${reasons}`,
    ``,
    `OFT: ${code(v.oft)} (chain ${v.chainId})`,
    `Recipient: ${code(recipient)}`,
    ``,
    attestationLine,
    txLine,
    ...tisLines,
  ].join("\n");

  const recipients = telegramRecipients(v);
  const sends: Promise<void>[] = [];
  if (recipients.publicChatId) {
    sends.push(sendTelegram(recipients.publicChatId, publicMessage, "public"));
  } else {
    console.warn("[alert:telegram:public] TELEGRAM_PUBLIC_ALERT_CHAT_ID is not set");
  }
  for (const chatId of recipients.teamChatIds) {
    sends.push(sendTelegram(chatId, teamMessage, "team"));
  }
  await Promise.all(sends);

  if (v.riskLevel === "CRITICAL") {
    postX(`🚨 ${v.ticker} OFT config drifted into CRITICAL state (score ${v.score}/100). ${v.reasons[0] ?? ""} Flagged and attested on-chain by OFT Sentinel.`);
  }

  return alertTxHash;
}
