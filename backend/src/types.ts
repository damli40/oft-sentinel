export type RiskLevel = "PASS" | "AT_RISK" | "CRITICAL";
// UNKNOWN = the check could not be evaluated (e.g. corridor read failed after
// retries) — never deducts score, so a transient RPC failure can't masquerade
// as a security finding.
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "PASS" | "UNKNOWN";

export interface Finding {
  severity: Severity;
  check: string;
  detail: string;
}

export interface DvnRow {
  chain: string;
  required: string[];
  optional: string[];
  confirmations: number;
}

// ── Sentinel ──────────────────────────────────────────────────────────────

/** A LayerZero ULN config for one route, normalized from on-chain reads. */
export interface UlnSnapshot {
  confirmations: number;
  requiredDVNCount: number;
  requiredDVNs: string[];
  optionalDVNCount: number;
  optionalDVNThreshold: number;
  optionalDVNs: string[];
}

/** One destination route's config as seen from the watched OFT's source chain. */
export interface RouteSnapshot {
  eid: number;
  chainName: string;
  chainKey: string | null;      // LZ chainKey of the destination (e.g. "ethereum") — for DVN name lookup
  sendLibrary: string | null;
  sendLibIsDefault: boolean | null;
  receiveLibrary: string | null;
  receiveLibIsDefault: boolean | null;
  uln: UlnSnapshot | null;
  // Receive-side ULN from the destination chain (needed for mismatch detection)
  receiveUln: UlnSnapshot | null;
  peer: string | null;
  peerAddress: string | null;   // the peer OFT address on the destination chain
  hasEnforcedOptions: boolean | null; // true if setEnforcedOptions was called for this eid
  isActive: boolean;
  rpcConflict?: boolean; // true if a secondary RPC returned different DVN config for this route
}

/** Full point-in-time config snapshot for a watched OFT. */
export interface OftSnapshot {
  oft: string;
  chainId: number; // chain the OFT lives on (Mantle = 5000)
  capturedAt: number;
  owner: string | null;
  ownerIsContract: boolean | null;
  proxyAdmin: string | null;           // EIP-1967 admin slot (null if not a proxy or slot is zero)
  proxyAdminOwner: string | null;      // who controls upgrades
  proxyAdminIsMultisig: boolean | null; // true if GnosisSafe detected
  routes: RouteSnapshot[];
}

export interface WatchedOft {
  ticker: string;
  address: string;
  chainId: number;
}

export interface DriftResult {
  drifted: boolean;
  reasons: string[];
}

/** Score/risk prediction if a single TIS remediation were applied. */
export interface PreflightResult {
  scoreBefore: number;
  riskBefore: RiskLevel;
  scoreAfter: number;
  riskAfter: RiskLevel;
}

/** A structured remediation proposal emitted alongside every verdict. */
export interface TransactionIntent {
  intent: string;           // e.g. "restore_dvn_redundancy" | "pin_receive_library"
  action: string;           // human-readable: what to do
  corridors?: string[];     // destination chain names affected (absent for non-route issues)
  dvnAddress?: string;
  dvnName?: string;
  currentState: string;
  targetState: string;
  reason: string;
  severity: Severity;
  preflight?: PreflightResult; // simulated outcome if this one issue were resolved
}

/**
 * Canonical, minimal record that gets hashed and attested on-chain.
 * The on-chain verdictHash = keccak256(JSON.stringify(pdr)).
 * Anyone can recompute: hash(this struct) == verdictHash in AuditRegistry.
 */
export interface PolicyDecisionRecord {
  oft: string;         // checksum address of the watched OFT
  chainId: number;     // Mantle mainnet (5000)
  findings: Finding[]; // full set of checks run — severity "PASS" + non-pass
  score: number;
  riskLevel: RiskLevel;
  evaluatedAt: number; // unix ms; matches what was hashed and submitted on-chain
  agentId: number;     // ERC-8004 token ID (SENTINEL_AGENT_ID env)
  rulesVersion: string; // "1.0.0"
}

/** A stored Sentinel verdict — the off-chain record mirrored by an on-chain attestation. */
export interface SentinelVerdict {
  oft: string;
  chainId: number;
  ticker: string;
  score: number;
  riskLevel: RiskLevel;
  verdict: string;
  reasons: string[];
  verdictHash: string;
  attestationId?: string;
  attestTxHash?: string;
  alertTxHash?: string;
  capturedAt: number;
  tis?: TransactionIntent[];
  pdr?: PolicyDecisionRecord; // stored so anyone can recompute verdictHash = hash(pdr)
}
