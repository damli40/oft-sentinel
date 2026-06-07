import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseEther, zeroAddress } from "viem";

const Risk = { UNKNOWN: 0, SAFE: 1, AT_RISK: 2, HIGH_RISK: 3, CRITICAL: 4 } as const;

const OFT = getAddress("0xc14459931cf666dccad582d63288aefb9f0bdca9"); // COOK
const URI = "registry://attest/1042";
const NUDGE = parseEther("0.001");

async function deploy() {
  const [owner, agent, recipient, stranger] = await hre.viem.getWalletClients();
  const bus = await hre.viem.deployContract("AlertBus");
  const pub = await hre.viem.getPublicClient();
  return { bus, owner, agent, recipient, stranger, pub };
}

describe("AlertBus", () => {
  it("emits an Alert and forwards the MNT nudge to the recipient", async () => {
    const { bus, recipient, pub } = await deploy();
    const before = await pub.getBalance({ address: recipient.account.address });

    await bus.write.alert(
      [OFT, 5000, recipient.account.address, 28, Risk.CRITICAL, 7n, URI],
      { value: NUDGE }
    );

    const after = await pub.getBalance({ address: recipient.account.address });
    expect(after - before).to.equal(NUDGE);

    const events = await bus.getEvents.Alert();
    expect(events.length).to.equal(1);
    const a = events[0].args;
    expect(getAddress(a.recipient!)).to.equal(getAddress(recipient.account.address));
    expect(getAddress(a.oft!)).to.equal(OFT);
    expect(a.score).to.equal(28);
    expect(a.risk).to.equal(Risk.CRITICAL);
    expect(a.agentId).to.equal(7n);
    expect(a.verdictURI).to.equal(URI);
    expect(a.nudged).to.equal(true);
    expect(a.nudgeWei).to.equal(NUDGE);
  });

  it("still emits the Alert (nudged=false) when the recipient rejects MNT, keeping funds recoverable", async () => {
    const { bus, owner, pub } = await deploy();
    const rejector = await hre.viem.deployContract("Rejector");

    await bus.write.alert(
      [OFT, 5000, rejector.address, 99, Risk.AT_RISK, 7n, URI],
      { value: NUDGE }
    );

    const events = await bus.getEvents.Alert();
    expect(events[0].args.nudged).to.equal(false);
    // failed nudge stays in the contract
    expect(await pub.getBalance({ address: bus.address })).to.equal(NUDGE);

    // owner can recover it
    await bus.write.withdraw([owner.account.address]);
    expect(await pub.getBalance({ address: bus.address })).to.equal(0n);
  });

  it("emits an Alert with no transfer when no value is attached", async () => {
    const { bus, recipient } = await deploy();
    await bus.write.alert([OFT, 5000, recipient.account.address, 50, Risk.AT_RISK, 1n, URI]);
    const events = await bus.getEvents.Alert();
    expect(events[0].args.nudged).to.equal(false);
    expect(events[0].args.nudgeWei).to.equal(0n);
  });

  it("reverts when a non-authorised account fires an alert", async () => {
    const { bus, stranger, recipient } = await deploy();
    const asStranger = await hre.viem.getContractAt("AlertBus", bus.address, {
      client: { wallet: stranger },
    });
    await expect(
      asStranger.write.alert([OFT, 5000, recipient.account.address, 50, Risk.AT_RISK, 1n, URI])
    ).to.be.rejected;
  });

  it("lets the owner authorise a new agent who can then alert", async () => {
    const { bus, agent, recipient } = await deploy();
    await bus.write.setAgent([agent.account.address, true]);
    const asAgent = await hre.viem.getContractAt("AlertBus", bus.address, {
      client: { wallet: agent },
    });
    await asAgent.write.alert([OFT, 5000, recipient.account.address, 75, Risk.AT_RISK, 9n, URI]);
    const events = await bus.getEvents.Alert();
    expect(events.length).to.equal(1);
  });

  it("rejects score > 100 and zero addresses", async () => {
    const { bus, recipient } = await deploy();
    await expect(
      bus.write.alert([OFT, 5000, recipient.account.address, 101, Risk.SAFE, 1n, URI])
    ).to.be.rejected;
    await expect(
      bus.write.alert([zeroAddress, 5000, recipient.account.address, 50, Risk.SAFE, 1n, URI])
    ).to.be.rejected;
    await expect(
      bus.write.alert([OFT, 5000, zeroAddress, 50, Risk.SAFE, 1n, URI])
    ).to.be.rejected;
  });
});
