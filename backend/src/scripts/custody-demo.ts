/**
 * Before/after demo for the custody-attestation rule (rulesVersion 1.1.0).
 * Runs the SAME demo snapshot through assessSnapshot twice: once with no
 * declaration, once with a declared Fireblocks MPC custody. Demo OFT only —
 * no real asset is named. Run: npx tsx src/scripts/custody-demo.ts
 */
import { assessSnapshot } from "../services/drift.js";
import type { CustodyDeclaration, OftSnapshot } from "../types.js";

const DEMO_SNAPSHOT: OftSnapshot = {
  oft: "0x0000000000000000000000000000000000001337", // labeled demo OFT
  chainId: 5000,
  capturedAt: Date.now(),
  owner: "0x00000000000000000000000000000000000DEmo1",
  ownerIsContract: false, // reads as a plain EOA on-chain
  proxyAdmin: null,
  proxyAdminOwner: null,
  proxyAdminIsMultisig: null,
  routes: [],
};

const DECLARATION: CustodyDeclaration = {
  custodyType: "fireblocks_mpc",
  declaredBy: "oft team (relayed)",
  declaredAt: "2026-07-07",
  verified: false,
};

async function main() {
  const before = await assessSnapshot(DEMO_SNAPSHOT, "DEMO", null);
  const after = await assessSnapshot(DEMO_SNAPSHOT, "DEMO", DECLARATION);

  const owner = (r: typeof before) => r.findings.find((f) => f.check === "Owner Type");

  console.log("── BEFORE (no declaration) ──────────────────────────────");
  console.log(`severity: ${owner(before)?.severity}  score: ${before.score}  risk: ${before.riskLevel}`);
  console.log(`detail:   ${owner(before)?.detail}`);
  console.log();
  console.log("── AFTER (declared fireblocks_mpc) ──────────────────────");
  console.log(`severity: ${owner(after)?.severity}  score: ${after.score}  risk: ${after.riskLevel}`);
  console.log(`detail:   ${owner(after)?.detail}`);
  console.log(`embedded: ${JSON.stringify(owner(after)?.custodyDeclaration)}`);
}

main();
