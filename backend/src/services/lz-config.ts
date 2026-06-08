import { createPublicClient, http, getAddress, type Address } from "viem";
import type { OftSnapshot, RouteSnapshot, UlnSnapshot } from "../types.js";

// LayerZero V2 endpoint — same address on every EVM chain.
const ENDPOINT = "0x1a44076050125825900e736c501f859c50fE728c" as Address;

// 4-byte selectors, mirrored from fetch_oft_config.py (the audited source of truth).
const SEL = {
  getSendLibrary:      "0xb96a277f", // (oapp,eid) → address
  isDefaultSendLibrary:"0xdc93c8a2", // (oapp,eid) → bool
  getReceiveLibrary:   "0x402f8468", // (oapp,eid) → (address lib, bool isDefault)
  getConfig:           "0x2b3197b9", // (oapp,lib,eid,configType) → bytes (UlnConfig)
  peers:               "0xbb0b6a53", // (eid) → bytes32
  owner:               "0x8da5cb5b", // () → address
  getThreshold:        "0xe75235b8", // GnosisSafe: () → uint256
  getEnforcedOptions:  "0x9ca12263", // (uint32,uint16) → bytes
} as const;

// ── Deployments-sourced EID map ───────────────────────────────────────────────
// Loaded dynamically from the authoritative LZ deployments API.
// chainKey is used directly as the DVN-metadata lookup key (no intermediate chainId).
// RPC URLs for destination-side receive reads are curated; absent = skip mismatch check.
const DEPLOYMENTS_URL = "https://metadata.layerzero-api.com/v1/metadata/deployments";

// Public RPCs for destination-side receive reads. Only needed for mismatch detection;
// primary signals (counts/confs/libs/owner) are all Mantle-side reads.
const CHAIN_RPC: Record<string, string> = {
  ethereum:    "https://eth.llamarpc.com",
  arbitrum:    "https://arb1.arbitrum.io/rpc",
  optimism:    "https://mainnet.optimism.io",
  base:        "https://mainnet.base.org",
  polygon:     "https://polygon-rpc.com",
  avalanche:   "https://api.avax.network/ext/bc/C/rpc",
  bsc:         "https://bsc-dataseed.binance.org",
  linea:       "https://rpc.linea.build",
  scroll:      "https://rpc.scroll.io",
  fraxtal:     "https://rpc.frax.com",
  blast:       "https://rpc.blast.io",
  mode:        "https://mainnet.mode.network",
  manta:       "https://pacific-rpc.manta.network/http",
  xlayer:      "https://rpc.xlayer.tech",
  rootstock:   "https://public-node.rsk.co",
  ink:         "https://rpc-gel.inkonchain.com",
  hyperliquid: "https://rpc.hyperliquid.xyz/evm",
  sei:         "https://evm-rpc.sei-apis.com",
  zircuit:     "https://zircuit-mainnet.drpc.org",
  worldchain:  "https://worldchain-mainnet.g.alchemy.com/public",
  zksync:      "https://mainnet.era.zksync.io",
  flare:       "https://flare-api.flare.network/ext/C/rpc",
};

export interface ChainInfo { chainKey: string; endpoint: string; rpc?: string }

let eidMapCache: { at: number; map: Record<number, ChainInfo> } | null = null;

/** Load the V2 EVM mainnet EID→chainKey map from the LZ deployments API.
 *  Cached 24 h. Only includes EIDs 30000–39999 with 0x endpoints (EVM, no sandboxes). */
export async function loadEidMap(): Promise<Record<number, ChainInfo>> {
  if (eidMapCache && Date.now() - eidMapCache.at < 24 * 3600_000) return eidMapCache.map;
  try {
    const res = await fetch(DEPLOYMENTS_URL);
    const raw = (await res.json()) as Record<string, { deployments?: any[] }>;
    const map: Record<number, ChainInfo> = {};
    for (const [, val] of Object.entries(raw)) {
      for (const dep of val.deployments ?? []) {
        if (dep.version !== 2) continue;
        const eid = Number(dep.eid);
        if (eid < 30000 || eid >= 40000) continue; // exclude sandboxes (50xxx) and legacy
        const ep: string = dep.endpointV2?.address ?? dep.endpoint?.address ?? "";
        if (!ep.startsWith("0x")) continue; // non-EVM (Solana, Aptos, TON, etc.)
        map[eid] = {
          chainKey: dep.chainKey as string,
          endpoint: ep,
          rpc: CHAIN_RPC[dep.chainKey as string],
        };
      }
    }
    eidMapCache = { at: Date.now(), map };
    return map;
  } catch {
    return eidMapCache?.map ?? {};
  }
}

// Source chain (Mantle) EID
const MANTLE_EID = 30181;

// EIP-1967 TransparentUpgradeableProxy admin slot
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as `0x${string}`;

// ── DVN metadata (chainKey-keyed) ─────────────────────────────────────────────
const DVN_META_URL = "https://metadata.layerzero-api.com/v1/metadata/dvns";

// byChain: chainKey → { addrLower → { name, deprecated } }
// globalFallback: addrLower → name  (only for addrs with identical name on every chain)
type DvnMeta = {
  byChain: Record<string, Record<string, { name: string; deprecated: boolean }>>;
  globalFallback: Record<string, string>;
};

let dvnMetaCache: { at: number; data: DvnMeta } | null = null;

export async function loadDvnMeta(): Promise<DvnMeta> {
  if (dvnMetaCache && Date.now() - dvnMetaCache.at < 24 * 3600_000) return dvnMetaCache.data;
  try {
    const res = await fetch(DVN_META_URL);
    const raw = (await res.json()) as Record<string, { dvns?: Record<string, any> }>;
    const byChain: Record<string, Record<string, { name: string; deprecated: boolean }>> = {};
    const allNames: Record<string, Set<string>> = {};
    for (const [chainKey, chainData] of Object.entries(raw)) {
      // Key directly by chainKey — same namespace as the deployments API.
      // No intermediate numeric-chainId mapping (that was the source of wrong names).
      for (const [addr, info] of Object.entries(chainData.dvns ?? {})) {
        const name = info.canonicalName ?? info.id ?? addr;
        const deprecated = !!info.deprecated;
        const key = addr.toLowerCase();
        if (!byChain[chainKey]) byChain[chainKey] = {};
        byChain[chainKey][key] = { name, deprecated };
        if (!allNames[key]) allNames[key] = new Set();
        allNames[key].add(name);
      }
    }
    const globalFallback: Record<string, string> = {};
    for (const [addr, names] of Object.entries(allNames)) {
      if (names.size === 1) globalFallback[addr] = [...names][0];
    }
    const data = { byChain, globalFallback };
    dvnMetaCache = { at: Date.now(), data };
    return data;
  } catch {
    return dvnMetaCache?.data ?? { byChain: {}, globalFallback: {} };
  }
}

// Human-readable overrides for opaque canonical names returned by the LZ metadata API.
// Keys are exact canonical names (case-sensitive) from the API's canonicalName field.
const FRIENDLY_DVN: Record<string, string> = {
  "Mantle01":    "Mantle DVN #1",
  "Mantle02":    "Mantle DVN #2",
  "Mantle03":    "Mantle DVN #3",
  "MantleCross": "MantleCross DVN",
  // LZDeadDVN is intentionally left as-is — it's a named LZ contract, not a generic label.
  // Any OFT route listing it as a required DVN is permanently message-blocked (null verifier).
  "TSS":         "TSS (Threshold Signature)",
  "StablecoinX": "StablecoinX",
  "Mantle Bank": "Mantle Bank DVN",
};

/** Resolve a DVN address to its canonical name, keyed by the chain's chainKey string.
 *  Falls back to globalFallback (same name on every chain) then address fragment.
 *  chainKey must be the LZ deployments chainKey (e.g. "mantle", "ethereum"), not a numeric ID. */
export function resolveDvn(addr: string, chainKey: string | null, meta: DvnMeta): string {
  const key = addr.toLowerCase();
  const raw = (chainKey && meta.byChain[chainKey]?.[key]?.name)
    ?? meta.globalFallback[key]
    ?? null;
  if (!raw) return `${addr.slice(0, 8)}…`;
  return FRIENDLY_DVN[raw] ?? raw;
}

export function isDvnDeprecated(addr: string, chainKey: string | null, meta: DvnMeta): boolean {
  const key = addr.toLowerCase();
  if (chainKey && meta.byChain[chainKey]?.[key]) return meta.byChain[chainKey][key].deprecated;
  return false;
}

// ── ABI encoding helpers ──────────────────────────────────────────────────────
function pad32(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}
function padAddr(addr: string): string { return pad32(addr.toLowerCase()); }
function padU32(n: number): string { return pad32(n.toString(16)); }

function uintAt(h: string, byteOffset: number): number {
  return Number(BigInt("0x" + h.slice(byteOffset * 2, byteOffset * 2 + 64)));
}
function addrAt(h: string, byteOffset: number): string {
  return getAddress("0x" + h.slice(byteOffset * 2, byteOffset * 2 + 64).slice(24));
}
function decodeAddr(raw: string): string | null {
  if (!raw || raw.length < 42) return null;
  const addr = "0x" + raw.slice(-40);
  if (BigInt(addr) === 0n) return null;
  return getAddress(addr);
}
function decodeAddressBool(raw: string): [string | null, boolean | null] {
  if (!raw || raw === "0x") return [null, null];
  const h = raw.slice(2);
  if (h.length < 128) return [null, null];
  return [getAddress("0x" + h.slice(24, 64)), BigInt("0x" + h.slice(64, 128)) !== 0n];
}

function decodeUlnConfig(raw: string): UlnSnapshot | null {
  if (!raw || raw === "0x") return null;
  const h = raw.slice(2);
  if (h.length < 192) return null;
  const S = 96;
  const confirmations      = uintAt(h, S);
  const requiredDVNCount   = uintAt(h, S + 32);
  const optionalDVNCount   = uintAt(h, S + 64);
  const optionalDVNThreshold = uintAt(h, S + 96);
  const reqOff = uintAt(h, S + 128);
  const optOff = uintAt(h, S + 160);
  const reqArr = S + reqOff;
  const reqLen = uintAt(h, reqArr);
  const requiredDVNs: string[] = [];
  for (let i = 0; i < reqLen; i++) requiredDVNs.push(addrAt(h, reqArr + 32 + i * 32));
  const optArr = S + optOff;
  const optLen = uintAt(h, optArr);
  const optionalDVNs: string[] = [];
  for (let i = 0; i < optLen; i++) optionalDVNs.push(addrAt(h, optArr + 32 + i * 32));
  return { confirmations, requiredDVNCount, requiredDVNs, optionalDVNCount, optionalDVNThreshold, optionalDVNs };
}

async function rawCall(client: ReturnType<typeof createPublicClient>, to: Address, data: string): Promise<string> {
  const res = await client.call({ to, data: data as `0x${string}` });
  return res.data ?? "0x";
}

// ── Snapshot reader ───────────────────────────────────────────────────────────

/**
 * Read the full ULN config for `oft` on its source chain via direct viem calls.
 *
 * What's new vs. the old hardcoded-5-chain version:
 *  - Sweeps peers() across ALL 17 known destination EIDs (dynamic route discovery)
 *  - Reads destination-side receive ULN for every active route (mismatch detection)
 *  - Chain-keyed DVN metadata (correct name resolution per chain — same address
 *    can map to a different DVN on a different chain, e.g. Nansen vs. USDT0)
 *  - EIP-1967 proxy admin slot + GnosisSafe detection
 */
export async function readSnapshot(oft: string, chainId: number, rpcUrl: string): Promise<OftSnapshot> {
  const srcClient = createPublicClient({ transport: http(rpcUrl) });
  const oftAddr = getAddress(oft) as Address;
  const [dvnMeta, eidMap] = await Promise.all([loadDvnMeta(), loadEidMap()]);

  // The source chain's chainKey — used for DVN name resolution of send-side configs.
  // Must be "mantle" (the LZ chainKey) not "5000" (the EVM chain ID).
  const srcChainKey = eidMap[MANTLE_EID]?.chainKey ?? "mantle";

  // ── Step 1: sweep ALL known V2 EVM EIDs to find active routes ───────────
  const activeEids: number[] = [];
  const peerAddresses: Record<number, string> = {};

  await Promise.all(
    Object.keys(eidMap).map(async (eidStr) => {
      const eid = Number(eidStr);
      if (eid === MANTLE_EID) return; // skip self
      try {
        const r = await rawCall(srcClient, oftAddr, SEL.peers + padU32(eid));
        if (r && r !== "0x" && BigInt(r) !== 0n) {
          activeEids.push(eid);
          // peers() returns bytes32 — last 20 bytes are the peer OFT address
          peerAddresses[eid] = getAddress("0x" + r.slice(-40));
        }
      } catch { /* no peer for this eid */ }
    })
  );

  // ── Step 2: read send-side ULN for each active route ─────────────────────
  const routes: RouteSnapshot[] = [];

  await Promise.all(
    activeEids.map(async (eid) => {
      const chainInfo = eidMap[eid];
      const route: RouteSnapshot = {
        eid,
        chainName: chainInfo?.chainKey ?? `eid-${eid}`,
        chainKey: chainInfo?.chainKey ?? null,
        sendLibrary: null,
        sendLibIsDefault: null,
        receiveLibrary: null,
        receiveLibIsDefault: null,
        uln: null,
        receiveUln: null,
        peer: peerAddresses[eid] ?? null,
        peerAddress: peerAddresses[eid] ?? null,
        hasEnforcedOptions: null,
        isActive: true,
      };

      try {
        route.sendLibrary = decodeAddr(
          await rawCall(srcClient, ENDPOINT, SEL.getSendLibrary + padAddr(oftAddr) + padU32(eid))
        );
      } catch { /* null */ }

      try {
        const r = await rawCall(srcClient, ENDPOINT, SEL.isDefaultSendLibrary + padAddr(oftAddr) + padU32(eid));
        route.sendLibIsDefault = r && r !== "0x" ? BigInt(r) !== 0n : null;
      } catch { /* null */ }

      try {
        const [lib, isDefault] = decodeAddressBool(
          await rawCall(srcClient, ENDPOINT, SEL.getReceiveLibrary + padAddr(oftAddr) + padU32(eid))
        );
        route.receiveLibrary = lib;
        route.receiveLibIsDefault = isDefault;
      } catch { /* null */ }

      if (route.sendLibrary) {
        try {
          route.uln = decodeUlnConfig(
            await rawCall(srcClient, ENDPOINT, SEL.getConfig + padAddr(oftAddr) + padAddr(route.sendLibrary) + padU32(eid) + padU32(2))
          );
        } catch { /* null */ }
      }

      // ── Enforced options ────────────────────────────────────────────────
      try {
        // Check msgType 1 (lzReceive). Non-zero / non-empty bytes = options set.
        const enf = await rawCall(srcClient, oftAddr, SEL.getEnforcedOptions + padU32(eid) + padU32(1));
        route.hasEnforcedOptions = enf !== "0x" && enf.length > 2 && BigInt(enf) !== 0n;
      } catch { /* null */ }

      // ── Step 3: destination-side receive ULN (for mismatch detection) ────
      const peerAddr = peerAddresses[eid];
      const dstRpc = chainInfo?.rpc;
      // Use the destination chain's own endpoint address (varies by chain).
      const dstEndpoint = (chainInfo?.endpoint ?? ENDPOINT) as Address;
      if (peerAddr && dstRpc) {
        try {
          const dstClient = createPublicClient({ transport: http(dstRpc) });
          const peerAddrChecked = getAddress(peerAddr) as Address;
          const [recvLib] = decodeAddressBool(
            await rawCall(dstClient, dstEndpoint, SEL.getReceiveLibrary + padAddr(peerAddrChecked) + padU32(MANTLE_EID))
          );
          if (recvLib) {
            route.receiveUln = decodeUlnConfig(
              await rawCall(dstClient, dstEndpoint, SEL.getConfig + padAddr(peerAddrChecked) + padAddr(recvLib) + padU32(MANTLE_EID) + padU32(2))
            );
          }
        } catch { /* receiveUln stays null */ }
      }

      routes.push(route);
    })
  );

  // ── Step 4: owner + EIP-1967 proxy admin ─────────────────────────────────
  let owner: string | null = null;
  let ownerIsContract: boolean | null = null;
  let proxyAdmin: string | null = null;
  let proxyAdminOwner: string | null = null;
  let proxyAdminIsMultisig: boolean | null = null;

  try {
    owner = decodeAddr(await rawCall(srcClient, oftAddr, SEL.owner));
    if (owner) {
      const code = await srcClient.getBytecode({ address: owner as Address });
      ownerIsContract = !!code && code !== "0x";
    }
  } catch { /* null */ }

  try {
    const slot = await srcClient.getStorageAt({ address: oftAddr, slot: EIP1967_ADMIN_SLOT });
    if (slot && slot !== "0x" && BigInt(slot) !== 0n) {
      proxyAdmin = getAddress("0x" + slot.slice(-40));
      // ProxyAdmin.owner()
      try {
        proxyAdminOwner = decodeAddr(await rawCall(srcClient, proxyAdmin as Address, SEL.owner));
        if (proxyAdminOwner) {
          // GnosisSafe detection: getThreshold()
          try {
            const thresh = await rawCall(srcClient, proxyAdminOwner as Address, SEL.getThreshold);
            proxyAdminIsMultisig = thresh !== "0x" && BigInt(thresh) > 0n;
          } catch { proxyAdminIsMultisig = false; }
        }
      } catch { /* null */ }
    }
  } catch { /* not a proxy */ }

  return {
    oft: oftAddr,
    chainId,
    capturedAt: Date.now(),
    owner,
    ownerIsContract,
    proxyAdmin,
    proxyAdminOwner,
    proxyAdminIsMultisig,
    routes,
  };
}
