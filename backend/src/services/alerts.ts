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
const MAINNET_EXPLORER = "https://mantlescan.xyz";

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

async function sendTelegram(chatId: string | null, text: string, label: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    console.log(`[alert:telegram:${label}:mock] ${text}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
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

  const txLine = alertTxHash ? `AlertBus tx: ${SEPOLIA_EXPLORER}/tx/${alertTxHash}` : "AlertBus tx: unavailable";
  const attestationLine = v.attestTxHash ? `Attestation tx: ${SEPOLIA_EXPLORER}/tx/${v.attestTxHash}` : "Attestation tx: unavailable";
  const reasons = v.reasons.length ? v.reasons.join("; ") : v.verdict;
  const publicMessage = [
    `OFT Sentinel alert: ${v.riskLevel} drift on ${v.ticker}`,
    `Score: ${v.score}/100`,
    `Reason: ${reasons}`,
    `OFT: ${MAINNET_EXPLORER}/address/${v.oft}`,
    attestationLine,
    txLine,
  ].join("\n");
  const teamMessage = [
    `Action needed: ${v.ticker} OFT drift detected`,
    `Risk: ${v.riskLevel}`,
    `Score: ${v.score}/100`,
    `Verdict: ${v.verdict}`,
    `Why: ${reasons}`,
    `OFT: ${v.oft} on chain ${v.chainId}`,
    `Owner nudge recipient: ${recipient}`,
    attestationLine,
    txLine,
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
    postX(`🚨 ${v.ticker} OFT config drifted into a CRITICAL state (score ${v.score}/100). ${v.reasons[0] ?? ""} — flagged + attested on-chain by OFT Sentinel.`);
  }

  return alertTxHash;
}
