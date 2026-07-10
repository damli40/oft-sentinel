/**
 * verify-dvn-invariants — assert, against the LIVE LayerZero metadata feed, the facts the
 * DVN layer's correctness depends on.
 *
 * Why this exists
 * ───────────────
 * `dead-dvn.test.ts` once contained a passing test asserting that dead-DVN detection is
 * "an ADDRESS union across all chains, so it must survive a wrong or missing chainKey."
 * That sentence was written as reasoning, a unit test pinned it in place, and it was false:
 * 14 addresses are an LZDeadDVN placeholder on one chain and a live DVN on another, so the
 * union suppressed real CRITICALs. Nothing checked the reasoning against the 1052-address
 * feed sitting one fetch() away.
 *
 * Unit tests with hand-written fixtures can only prove the code does what its author
 * believed. They cannot prove the belief. Any assertion about EXTERNAL data has to be
 * derived from that data, and has to fail when reality moves.
 *
 * This script is that check. It is deliberately NOT part of `vitest run` — it needs the
 * network, and a monitor's test suite must stay hermetic. Run it in CI on a schedule, and
 * before touching anything in the DVN layer.
 *
 *   npx tsx src/scripts/verify-dvn-invariants.ts
 *
 * Exits non-zero when an invariant breaks. A break is not necessarily a bug in Sentinel —
 * it may mean LayerZero changed its metadata shape — but it always means a comment,
 * a test, or a lookup somewhere is now lying.
 */

const DVN_URL = "https://metadata.layerzero-api.com/v1/metadata/dvns";
const DEPLOYMENTS_URL = "https://metadata.layerzero-api.com/v1/metadata/deployments";

type DvnInfo = { canonicalName?: string; id?: string; deprecated?: boolean };
type DeployRec = { chainKey?: string; eid?: string | number; version?: number; stage?: string; deadDVN?: { address?: string } };

const isDeadName = (n: string) => /dead\s*dvn/i.test(n);

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const [dvnRaw, depRaw] = await Promise.all([
    fetch(DVN_URL).then((r) => r.json() as Promise<Record<string, { dvns?: Record<string, DvnInfo> }>>),
    fetch(DEPLOYMENTS_URL).then((r) => r.json() as Promise<Record<string, { deployments?: DeployRec[] }>>),
  ]);

  // addr → chainKey(dvn-api namespace) → info
  const byAddr = new Map<string, Map<string, DvnInfo>>();
  for (const [chainKey, cd] of Object.entries(dvnRaw)) {
    for (const [addr, info] of Object.entries(cd.dvns ?? {})) {
      const k = addr.toLowerCase();
      if (!byAddr.has(k)) byAddr.set(k, new Map());
      byAddr.get(k)!.set(chainKey, info);
    }
  }

  console.log(`\nDVN metadata: ${Object.keys(dvnRaw).length} chains, ${byAddr.size} distinct addresses\n`);

  // ── INVARIANT 1 ────────────────────────────────────────────────────────────
  // A DVN address is NOT a globally unique identity. If this ever becomes true, the
  // per-chain keying is merely redundant rather than load-bearing — but until then, any
  // address-only lookup is a latent severity bug.
  const nameOf = (i: DvnInfo, a: string) => i.canonicalName ?? i.id ?? a;
  const multi = [...byAddr.entries()].filter(([, m]) => m.size > 1);
  const nameCollide = multi.filter(([a, m]) => new Set([...m.values()].map((i) => nameOf(i, a))).size > 1);
  const depCollide = multi.filter(([, m]) => new Set([...m.values()].map((i) => !!i.deprecated)).size > 1);
  check(
    "DVN identity is per-chain, not per-address",
    nameCollide.length > 0,
    `${multi.length} addresses on >1 chain; ${nameCollide.length} carry different names per chain; ` +
      `${depCollide.length} differ in their deprecated flag. Address-only lookup is unsafe.`,
  );

  // ── INVARIANT 2 ────────────────────────────────────────────────────────────
  // The one that inverted dead-dvn.test.ts. A flat cross-chain dead-address union
  // misclassifies these as dead placeholders on chains where they are live verifiers,
  // suppressing the CRITICAL on any 1-of-1 that uses them.
  const deadLive = multi.filter(([a, m]) => {
    const names = [...m.values()].map((i) => nameOf(i, a));
    return names.some(isDeadName) && names.some((n) => !isDeadName(n));
  });
  check(
    "dead-DVN detection MUST be per-chain (flat union suppresses real CRITICALs)",
    deadLive.length > 0,
    `${deadLive.length} addresses are LZDeadDVN on ≥1 chain and a LIVE DVN on ≥1 other.`,
  );
  for (const [a, m] of deadLive.slice(0, 3)) {
    const dead = [...m.entries()].filter(([, i]) => isDeadName(nameOf(i, a))).map(([c]) => c);
    const live = [...m.entries()].filter(([, i]) => !isDeadName(nameOf(i, a)));
    console.log(`        ${a}\n          dead on ${dead.length}: ${dead.slice(0, 4).join(", ")}` +
      `\n          LIVE on ${live.length}: ${live.slice(0, 3).map(([c, i]) => `${c}="${nameOf(i, a)}"`).join(", ")}`);
  }

  // ── INVARIANT 3 ────────────────────────────────────────────────────────────
  // The DVN API and the deployments API do not share a chainKey namespace. buildDvnKeyMap()
  // recovers the mapping by joining on eid. If the join ever stops finding these, a whole
  // chain's DVN table silently disappears (and, pre-3.0.0, globalFallback hid that).
  const aliases: Array<{ dvnKey: string; chainKey: string }> = [];
  for (const [topKey, val] of Object.entries(depRaw)) {
    for (const d of val.deployments ?? []) {
      if (d.version !== 2 || d.stage !== "mainnet" || !d.chainKey) continue;
      const dvnKey = topKey.replace(/-mainnet$/, "");
      if (dvnKey !== d.chainKey) aliases.push({ dvnKey, chainKey: d.chainKey });
    }
  }
  check(
    "the two metadata APIs use DIFFERENT chainKey namespaces (join on eid, never on name)",
    aliases.length > 0,
    aliases.map((a) => `DVN-API "${a.dvnKey}" = Sentinel "${a.chainKey}"`).join("; ") || "none found",
  );

  // ── INVARIANT 4 ────────────────────────────────────────────────────────────
  // Every aliased chain must actually carry DVNs, else the alias buys nothing.
  for (const { dvnKey, chainKey } of aliases) {
    const n = Object.keys(dvnRaw[dvnKey]?.dvns ?? {}).length;
    const deprecated = Object.entries(dvnRaw[dvnKey]?.dvns ?? {}).filter(([, i]) => i.deprecated).length;
    check(
      `aliased chain "${chainKey}" resolves to a populated DVN table`,
      n > 0,
      `${n} DVNs (${deprecated} deprecated) under DVN-API key "${dvnKey}" — invisible without the alias.`,
    );
  }

  // ── INVARIANT 5 ────────────────────────────────────────────────────────────
  // deadDVN is an OBJECT with .address. It has been a bare string in other LZ payloads;
  // if it ever changes, `d.deadDVN?.address` silently yields undefined and the per-chain
  // dead set empties out, turning every dead pathway into a false CRITICAL.
  let deadObjects = 0, deadStrings = 0;
  for (const val of Object.values(depRaw)) {
    for (const d of val.deployments ?? []) {
      if (d.deadDVN === undefined) continue;
      if (typeof d.deadDVN === "string") deadStrings++;
      else if (typeof d.deadDVN?.address === "string") deadObjects++;
    }
  }
  check(
    "deployments[].deadDVN is { address } — not a bare string",
    deadObjects > 0 && deadStrings === 0,
    `${deadObjects} object-shaped, ${deadStrings} string-shaped.`,
  );

  console.log(`\n${failures === 0 ? "All DVN invariants hold." : `${failures} INVARIANT(S) BROKEN.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
