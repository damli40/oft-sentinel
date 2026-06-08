// Register OFT Sentinel as an ERC-8004 identity on Mantle Sepolia.
// Run once. Saves SENTINEL_AGENT_ID to backend/.env.
//
//   npx hardhat run scripts/register-sentinel.ts --network mantleSepolia

import { createPublicClient, createWalletClient, http, defineChain, decodeEventLog, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import * as dotenv from "dotenv";

dotenv.config();

const MANTLE_SEPOLIA = defineChain({
  id: 5003,
  name: "Mantle Sepolia",
  nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.sepolia.mantle.xyz"] } },
  blockExplorers: { default: { name: "MantleScan Sepolia", url: "https://sepolia.mantlescan.xyz" } },
});

// ERC-8004 canonical registry — deterministic CREATE2 deploy (0x8004 prefix is intentional).
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as `0x${string}`;
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as `0x${string}`;

const IDENTITY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "Transfer",
    type: "event",
    inputs: [
      { name: "from",    type: "address", indexed: true },
      { name: "to",      type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

const REPUTATION_ABI = [
  {
    name: "recordFeedback",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId",  type: "uint256" },
      { name: "score",    type: "uint256" },
      { name: "comments", type: "string" },
    ],
    outputs: [],
  },
] as const;

// OFT Sentinel agent metadata.
const METADATA_URI =
  "data:application/json;base64,eyJuYW1lIjoiT0ZUIFNlbnRpbmVsIiwiZGVzY3JpcHRpb24iOiJBdXRvbm9tb3VzIExheWVyWmVybyBPRlQgc2VjdXJpdHkgbW9uaXRvcmluZyBhZ2VudCBmb3IgTWFudGxlLiBEZXRlY3RzIERWTiBjb25maWd1cmF0aW9uIGRyaWZ0LCBhc3Nlc3NlcyBjcm9zcy1jaGFpbiBicmlkZ2UgcmlzaywgYW5kIGF0dGVzdHMgaW1tdXRhYmxlIHZlcmRpY3RzIG9uLWNoYWluLiIsInZlcnNpb24iOiIxLjAuMCIsInR5cGUiOiJzZWN1cml0eS1tb25pdG9yIiwiY2FwYWJpbGl0aWVzIjpbImR2bi1tb25pdG9yaW5nIiwiZHJpZnQtZGV0ZWN0aW9uIiwicmlzay1zY29yaW5nIiwib24tY2hhaW4tYXR0ZXN0YXRpb24iLCJ0ZWxlZ3JhbS1hbGVydGluZyJdLCJtb25pdG9yZWQiOiJMYXllclplcm8gVjIgT0ZUcyBvbiBNYW50bGUgKGNoYWluSWQgNTAwMCkiLCJoYWNrYXRob24iOiJNYW50bGUgVHVyaW5nIFRlc3QgSGFja2F0aG9uIDIwMjYiLCJyZXBvIjoiaHR0cHM6Ly9naXRodWIuY29tL2RhbWl4NTUvb2Z0LWF1ZGl0LXByb2R1Y3QifQ==";

function patchEnv(path: string, key: string, value: string): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = current.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
  writeFileSync(path, lines.filter((_, i) => i < lines.length - 1 || lines[i]).join("\n") + "\n");
  console.log(`  .env updated: ${key}=${value}`);
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set in contracts/.env");

  const account = privateKeyToAccount(pk as `0x${string}`);
  console.log(`Registering OFT Sentinel identity from ${account.address}`);

  const pub = createPublicClient({ chain: MANTLE_SEPOLIA, transport: http() });
  const wallet = createWalletClient({ account, chain: MANTLE_SEPOLIA, transport: http() });

  // ── 1. Register identity ────────────────────────────────────────────────
  console.log("\n[1/2] Calling IdentityRegistry.register()…");
  const registerHash = await wallet.writeContract({
    address: IDENTITY_REGISTRY,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [METADATA_URI],
  });
  console.log(`  tx: ${registerHash}`);

  const receipt = await pub.waitForTransactionReceipt({ hash: registerHash });
  console.log(`  confirmed in block ${receipt.blockNumber}`);

  // Extract tokenId from Transfer(from=0, to=account, tokenId) event.
  const transferLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase(),
  );
  if (!transferLog) throw new Error("Transfer event not found in receipt");

  const decoded = decodeEventLog({
    abi: IDENTITY_ABI,
    eventName: "Transfer",
    data: transferLog.data,
    topics: transferLog.topics,
  });
  const agentId = (decoded.args as any).tokenId as bigint;
  console.log(`\n  Agent ID: ${agentId}`);
  console.log(`  Explorer: https://sepolia.mantlescan.xyz/tx/${registerHash}`);

  // ── 2. Record initial reputation ────────────────────────────────────────
  console.log("\n[2/2] Recording initial reputation…");
  try {
    const repHash = await wallet.writeContract({
      address: REPUTATION_REGISTRY,
      abi: REPUTATION_ABI,
      functionName: "recordFeedback",
      args: [agentId, 90n, "OFT Sentinel — autonomous LayerZero security monitor, Mantle Turing Test 2026"],
    });
    await pub.waitForTransactionReceipt({ hash: repHash });
    console.log(`  Reputation recorded. Tx: ${repHash}`);
    console.log(`  Explorer: https://sepolia.mantlescan.xyz/tx/${repHash}`);
  } catch (err: any) {
    console.warn(`  Reputation step skipped: ${err.shortMessage ?? err.message}`);
  }

  // ── 3. Persist agentId to backend/.env ─────────────────────────────────
  const backendEnv = resolve(__dirname, "../../backend/.env");
  patchEnv(backendEnv, "SENTINEL_AGENT_ID", agentId.toString());

  console.log(`\nDone. Re-start the backend to pick up SENTINEL_AGENT_ID=${agentId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
