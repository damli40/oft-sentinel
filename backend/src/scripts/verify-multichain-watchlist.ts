// Local verification for the ETH/Base multichain watchlist wiring.
// NOT part of the app or test suite — a throwaway proof for the branch.
// Confirms: (1) getWatched() now spans Mantle + Ethereum + Base with correct
// chainIds, (2) live readSnapshot resolves through the registry on the new chains.
import "dotenv/config";
import { getWatched } from "../services/sentinel.js";
import { readSnapshot } from "../services/lz-config.js";
import { assessSnapshot } from "../services/drift.js";
import { getChainRef } from "../services/chain-registry.js";

async function main() {
  const watched = (await getWatched(true)).filter((w) => w.ticker !== "DEMO");
  const byChain = new Map<number, number>();
  for (const w of watched) byChain.set(w.chainId, (byChain.get(w.chainId) ?? 0) + 1);

  console.log("=== watchlist chain breakdown ===");
  for (const [chainId, n] of [...byChain].sort((a, b) => a[0] - b[0])) {
    const ref = getChainRef(chainId);
    console.log(`  chain ${chainId} (${ref?.chainKey ?? "?"} / eid ${ref?.eid ?? "?"}): ${n} OFTs`);
  }
  console.log(`  TOTAL: ${watched.length} OFT-chain pairs\n`);

  // One live read per new chain — prove viem resolves through the registry there.
  const probes: Array<[string, string, number]> = [
    ["USDT0 (ethereum)", "0x6c96de32cea08842dcc4058c14d3aaad7fa41dee", 1],
    ["USDe (base)", "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", 8453],
  ];
  for (const [label, addr, chainId] of probes) {
    const ref = getChainRef(chainId);
    if (!ref) { console.log(`${label}: NO ChainRef — FAIL`); continue; }
    try {
      const snap = await readSnapshot(addr, ref);
      const active = snap.routes.filter((r) => r.isActive).length;
      const withUln = snap.routes.filter((r) => r.isActive && r.uln !== null).length;
      const { score, riskLevel, findings } = await assessSnapshot(snap, label.split(" ")[0]);
      console.log(`${label}: read OK — ${snap.routes.length} routes, ${active} active, ${withUln} with ULN`);
      console.log(`    verdict: score ${score} / ${riskLevel} / ${findings.length} findings`);
    } catch (e: any) {
      console.log(`${label}: read FAILED — ${e.shortMessage ?? e.message}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
