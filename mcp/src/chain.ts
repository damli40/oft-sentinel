import { createPublicClient, http } from "viem";

// The Sepolia RPC is env-configured ONLY (SENTINEL_SEPOLIA_RPC) — never a tool
// input an agent could redirect to a malicious RPC that returns a fake hash.
const SEPOLIA_RPC = process.env.SENTINEL_SEPOLIA_RPC ?? "https://rpc.sepolia.mantle.xyz";
const MANTLE_SEPOLIA_ID = 5003;

// Exact ABI fragment from contracts/artifacts AuditRegistry.json: get(uint256)
// returns the Attestation struct.
const GET_ATTESTATION_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "id", type: "uint256" }],
    name: "get",
    outputs: [
      {
        components: [
          { internalType: "address", name: "oft", type: "address" },
          { internalType: "uint32", name: "chainId", type: "uint32" },
          { internalType: "bytes32", name: "verdictHash", type: "bytes32" },
          { internalType: "uint8", name: "score", type: "uint8" },
          { internalType: "enum AuditRegistry.RiskLevel", name: "risk", type: "uint8" },
          { internalType: "uint256", name: "agentId", type: "uint256" },
          { internalType: "uint64", name: "timestamp", type: "uint64" },
        ],
        internalType: "struct AuditRegistry.Attestation",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface OnChainAttestation {
  verdictHash: string;
  score?: number;
  agentId?: bigint;
  timestamp?: bigint;
}

export async function readAttestation(registry: `0x${string}`, id: bigint): Promise<OnChainAttestation> {
  const client = createPublicClient({
    chain: {
      id: MANTLE_SEPOLIA_ID,
      name: "Mantle Sepolia",
      nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
      rpcUrls: { default: { http: [SEPOLIA_RPC] } },
    },
    transport: http(SEPOLIA_RPC, { timeout: 15_000 }),
  });
  const att = await client.readContract({
    address: registry,
    abi: GET_ATTESTATION_ABI,
    functionName: "get",
    args: [id],
  });
  return { verdictHash: att.verdictHash, score: att.score, agentId: att.agentId, timestamp: att.timestamp };
}

export function sepoliaRpcName(): string {
  return SEPOLIA_RPC;
}
