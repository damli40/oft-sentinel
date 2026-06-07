import { expect } from "chai";
import hre from "hardhat";
import { getAddress, keccak256, toHex, zeroAddress } from "viem";

// RiskLevel enum mirror (see AuditRegistry.sol)
const Risk = { UNKNOWN: 0, SAFE: 1, AT_RISK: 2, HIGH_RISK: 3, CRITICAL: 4 } as const;

const OFT_A = getAddress("0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"); // sUSDe
const OFT_B = getAddress("0x6985884C4392D348587B19cb9eAAf157F13271cd"); // ZRO
const verdictHash = keccak256(toHex("verdict-report-v1"));

async function deploy() {
  const [owner, agent, stranger] = await hre.viem.getWalletClients();
  const registry = await hre.viem.deployContract("AuditRegistry");
  return { registry, owner, agent, stranger };
}

describe("AuditRegistry", () => {
  it("sets deployer as owner and first authorised agent", async () => {
    const { registry, owner } = await deploy();
    expect(getAddress(await registry.read.owner())).to.equal(
      getAddress(owner.account.address)
    );
    expect(await registry.read.authorizedAgents([owner.account.address])).to.equal(true);
  });

  it("records an attestation and exposes it via get/latestOf/total", async () => {
    const { registry } = await deploy();
    await registry.write.attest([OFT_A, 5000, verdictHash, 28, Risk.CRITICAL, 1n]);

    expect(await registry.read.total()).to.equal(1n);

    const att = await registry.read.get([0n]);
    expect(getAddress(att.oft)).to.equal(OFT_A);
    expect(att.chainId).to.equal(5000);
    expect(att.verdictHash).to.equal(verdictHash);
    expect(att.score).to.equal(28);
    expect(att.risk).to.equal(Risk.CRITICAL);
    expect(att.agentId).to.equal(1n);

    const [latest, exists] = await registry.read.latestOf([OFT_A, 5000]);
    expect(exists).to.equal(true);
    expect(latest.score).to.equal(28);
  });

  it("keeps per-target drift history and returns the latest verdict", async () => {
    const { registry } = await deploy();
    await registry.write.attest([OFT_A, 5000, verdictHash, 90, Risk.SAFE, 1n]);
    await registry.write.attest([OFT_A, 5000, verdictHash, 28, Risk.CRITICAL, 1n]); // config drifted

    expect(await registry.read.countOf([OFT_A, 5000])).to.equal(2n);
    const history = await registry.read.historyOf([OFT_A, 5000]);
    expect(history.length).to.equal(2);

    const [latest] = await registry.read.latestOf([OFT_A, 5000]);
    expect(latest.score).to.equal(28); // latest reflects the drift
    expect(latest.risk).to.equal(Risk.CRITICAL);
  });

  it("isolates targets by (oft, chainId)", async () => {
    const { registry } = await deploy();
    await registry.write.attest([OFT_A, 5000, verdictHash, 90, Risk.SAFE, 1n]);
    await registry.write.attest([OFT_A, 1, verdictHash, 40, Risk.HIGH_RISK, 1n]);

    const [, existsB] = await registry.read.latestOf([OFT_B, 5000]);
    expect(existsB).to.equal(false);
    expect(await registry.read.countOf([OFT_A, 5000])).to.equal(1n);
    expect(await registry.read.countOf([OFT_A, 1])).to.equal(1n);
  });

  it("reverts when a non-authorised account attests", async () => {
    const { registry, stranger } = await deploy();
    const asStranger = await hre.viem.getContractAt(
      "AuditRegistry",
      registry.address,
      { client: { wallet: stranger } }
    );
    await expect(
      asStranger.write.attest([OFT_A, 5000, verdictHash, 50, Risk.AT_RISK, 1n])
    ).to.be.rejected;
  });

  it("lets the owner authorise a new agent who can then attest", async () => {
    const { registry, agent } = await deploy();
    await registry.write.setAgent([agent.account.address, true]);
    expect(await registry.read.authorizedAgents([agent.account.address])).to.equal(true);

    const asAgent = await hre.viem.getContractAt(
      "AuditRegistry",
      registry.address,
      { client: { wallet: agent } }
    );
    await asAgent.write.attest([OFT_B, 5000, verdictHash, 75, Risk.AT_RISK, 7n]);
    expect(await registry.read.total()).to.equal(1n);
  });

  it("rejects score > 100 and zero OFT address", async () => {
    const { registry } = await deploy();
    await expect(
      registry.write.attest([OFT_A, 5000, verdictHash, 101, Risk.SAFE, 1n])
    ).to.be.rejected;
    await expect(
      registry.write.attest([zeroAddress, 5000, verdictHash, 50, Risk.SAFE, 1n])
    ).to.be.rejected;
  });
});
