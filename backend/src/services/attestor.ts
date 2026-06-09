import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  keccak256,
  toHex,
  getAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RiskLevel } from "../types.js";

// AuditRegistry.attest(oft, chainId, verdictHash, score, risk, agentId) → id
const REGISTRY_ABI = [
  {
    name: "attest",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "oft", type: "address" },
      { name: "chainId", type: "uint32" },
      { name: "verdictHash", type: "bytes32" },
      { name: "score", type: "uint8" },
      { name: "risk", type: "uint8" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  { name: "total", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// AuditRegistry.RiskLevel enum: UNKNOWN=0, SAFE=1, AT_RISK=2, HIGH_RISK=3, CRITICAL=4
const RISK_ENUM: Record<RiskLevel, number> = { PASS: 1, AT_RISK: 2, CRITICAL: 4 };

const SENTINEL_CHAIN_ID = Number(process.env.SENTINEL_CHAIN_ID ?? 5003);
const SENTINEL_RPC = process.env.SENTINEL_RPC ?? "https://rpc.sepolia.mantle.xyz";
const AGENT_ID = BigInt(process.env.SENTINEL_AGENT_ID ?? 1);

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

function registryAddress(): Address {
  const a = process.env.AUDIT_REGISTRY_ADDRESS;
  if (!a) throw new Error("AUDIT_REGISTRY_ADDRESS not set");
  return getAddress(a) as Address;
}

export function verdictHash(report: unknown): `0x${string}` {
  return keccak256(toHex(JSON.stringify(report)));
}

export interface AttestResult {
  txHash: string;
  attestationId: string;
}

/**
 * Write a verdict to AuditRegistry on Mantle Sepolia. The `watchedChainId` arg
 * is the chain the OFT lives on (Mantle mainnet 5000) — recorded in the
 * attestation — while the tx itself lands on the contract's chain (Sepolia).
 */
export async function attest(
  oft: string,
  watchedChainId: number,
  hash: `0x${string}`,
  score: number,
  risk: RiskLevel
): Promise<AttestResult> {
  const acct = account();
  const wallet = createWalletClient({ account: acct, chain: sentinelChain, transport: http(SENTINEL_RPC) });
  const pub = createPublicClient({ chain: sentinelChain, transport: http(SENTINEL_RPC) });
  const registry = registryAddress();

  const txHash = await wallet.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "attest",
    args: [getAddress(oft), watchedChainId, hash, score, RISK_ENUM[risk], AGENT_ID],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });

  // Parse attestation ID from the Attested event emitted in the receipt.
  // Pre-reading total() before the tx races when multiple OFTs attest concurrently:
  // both callers can read the same total() and one ends up storing the wrong ID.
  // Attested(uint256 indexed id, address indexed oft, uint32, bytes32, uint8, uint8, uint256 indexed agentId, uint64)
  const ATTESTED_SIG = keccak256(toHex("Attested(uint256,address,uint32,bytes32,uint8,uint8,uint256,uint64)")) as `0x${string}`;
  const attestedLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === registry.toLowerCase() && l.topics[0] === ATTESTED_SIG
  );
  const attestationId = attestedLog?.topics[1] != null
    ? BigInt(attestedLog.topics[1]).toString()
    : "unknown";

  // Post-state: confirm the ID is within the registry's total count.
  // Brief pause lets the RPC node catch up before reading total() — avoids
  // a stale-read false positive on Mantle Sepolia's load-balanced endpoints.
  if (attestationId !== "unknown") {
    try {
      await new Promise(r => setTimeout(r, 800));
      const total = await pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "total" });
      if (total <= BigInt(attestationId)) {
        console.warn(`[attestor] post-state mismatch: attestationId=${attestationId} registry total=${total}`);
      }
    } catch (e: any) {
      console.warn(`[attestor] post-state check failed:`, e.shortMessage ?? e.message);
    }
  }

  return { txHash, attestationId };
}
