import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ChainRef, ChainRpc } from "../types.js";

// The chain registry is a COMMITTED build artifact (public data only) that ships
// with the code — unlike custody declarations, which are operator input on the
// runtime volume. It is therefore resolved relative to the module (backend root)
// and NOT under DATA_DIR. A missing or malformed file is a build error: fail
// loudly at first read rather than silently monitoring nothing.
const REGISTRY_BASENAME = "chain-registry.json";
const MANTLE_CHAIN_ID = 5000;

interface RawRegistry {
  generatedAt?: string;
  source?: string;
  chains: Record<string, ChainRef>;
}

/** Normalize a provider label so quorum counting can't be fooled by cosmetic
 *  variants: lowercase, strip an `other-` prefix, and collapse every thirdweb
 *  proxy variant (`{chainId}.rpc.thirdweb.com` is one generic keyless proxy).
 *  Must match the generator's normalization exactly. */
export function normalizeProvider(provider: string): string {
  let p = (provider ?? "").toLowerCase().trim();
  if (p.startsWith("other-")) p = p.slice("other-".length);
  if (p.includes("thirdweb")) return "thirdweb";
  return p;
}

/** Distinct normalized providers backing verified endpoints. */
export function distinctProviderCount(rpcs: ChainRpc[]): number {
  return new Set(rpcs.map((r) => normalizeProvider(r.provider))).size;
}

/** Quorum invariant: a chain is monitorable only with ≥2 RPCs from ≥2 distinct
 *  providers. Enforced here (not just trusted from the file) so a mislabeled
 *  registry can never bypass the multi-RPC quorum. */
export function meetsQuorum(rpcs: ChainRpc[]): boolean {
  return rpcs.length >= 2 && distinctProviderCount(rpcs) >= 2;
}

export function registryFile(): string {
  if (process.env.CHAIN_REGISTRY_PATH) return resolve(process.env.CHAIN_REGISTRY_PATH);
  // <backend>/chain-registry.json — two levels up from src/services/.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", REGISTRY_BASENAME);
}

// Cached per process. Keyed by the resolved file path so a test that swaps
// CHAIN_REGISTRY_PATH gets a fresh load instead of a stale cache.
let cache: { path: string; byChainId: Map<number, ChainRef>; byKey: Map<string, ChainRef> } | null = null;

/** Apply the MANTLE_RPC env override: if set and this is the Mantle entry,
 *  promote that URL to rpcs[0] (dedup by URL) for backward compat with existing
 *  single-chain deployments. Never mutates the source object. */
function applyMantleRpcOverride(ref: ChainRef): ChainRef {
  const override = process.env.MANTLE_RPC;
  if (!override || ref.chainId !== MANTLE_CHAIN_ID) return ref;
  const rest = ref.rpcs.filter((r) => r.url !== override);
  const promoted: ChainRpc = { url: override, provider: "official" };
  // Preserve the provider label if the override URL already exists in the set.
  const existing = ref.rpcs.find((r) => r.url === override);
  return { ...ref, rpcs: [existing ?? promoted, ...rest] };
}

function load(): { byChainId: Map<number, ChainRef>; byKey: Map<string, ChainRef> } {
  const path = registryFile();
  if (cache && cache.path === path) return cache;

  let raw: RawRegistry;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as RawRegistry;
  } catch (e: any) {
    throw new Error(`chain-registry: cannot read/parse ${path}: ${e.message}`);
  }
  if (!raw || typeof raw !== "object" || !raw.chains || typeof raw.chains !== "object") {
    throw new Error(`chain-registry: malformed registry at ${path} (missing "chains")`);
  }

  const byChainId = new Map<number, ChainRef>();
  const byKey = new Map<string, ChainRef>();
  for (const [chainKey, entry] of Object.entries(raw.chains)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`chain-registry: malformed entry for "${chainKey}"`);
    }
    // Enforce the quorum invariant at load time: eligible only if the file says
    // so AND the endpoints actually satisfy ≥2-distinct-provider quorum. This
    // makes it impossible for a mislabeled registry to bypass invariant 3.
    const eligible = entry.eligible && meetsQuorum(entry.rpcs ?? []);
    const ref = applyMantleRpcOverride({ ...entry, eligible });
    byChainId.set(ref.chainId, ref);
    byKey.set(ref.chainKey, ref);
  }
  cache = { path, byChainId, byKey };
  return cache;
}

/** Force a reload on the next lookup — for tests that swap the registry file. */
export function _resetChainRegistryCache(): void {
  cache = null;
}

export function getChainRef(chainId: number): ChainRef | null {
  return load().byChainId.get(chainId) ?? null;
}

export function getChainRefByKey(chainKey: string): ChainRef | null {
  return load().byKey.get(chainKey) ?? null;
}

export function listEligibleChains(): ChainRef[] {
  return [...load().byKey.values()].filter((c) => c.eligible);
}
