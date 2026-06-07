export type RiskLevel = "PASS" | "AT_RISK" | "CRITICAL";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "PASS";

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
}
