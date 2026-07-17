import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.js";
import type { StatusPayload, WatchedEntry } from "../format.js";

// latestVerdict shape pinned from prod /status 2026-07-17 (Puff/mantle).
const puff: WatchedEntry = {
  ticker: "Puff",
  address: "0xe6fa1be9daa660c99268f3f47fc193ba066a3aac",
  chainId: 5000,
  lastSnapshotAt: 1784263908376,
  corridors: ["ethereum", "base"],
  assessment: {
    score: 0,
    riskLevel: "CRITICAL",
    reasons: ["ethereum: 2 block confirmations (< 15, reorg risk)."],
    tis: [
      { action: "Pin the receive library to a specific version", severity: "CRITICAL", corridors: ["ethereum", "base"] },
      { action: "Raise confirmation threshold to ≥15 blocks", severity: "MEDIUM", corridors: ["ethereum"] },
    ],
  },
  latestVerdict: {
    verdict: "Persistent CRITICAL config — pre-existing risk, no drift (score 0/100)",
    verdictHash: "0xdeec9572e56401295dd201f60babbc108e249afb23dbce6994ccb73e0ef99e4c",
    capturedAt: 1784263908376,
    attestTxHash: "0x0d52d82afdb2f5bb1376232b82075b0a5e4517134a625439df1aee7fc5883ed4",
    attestationId: "526",
  },
};

const neverAttested: WatchedEntry = {
  ...puff,
  ticker: "Quiet",
  address: "0x1111111111111111111111111111111111111111",
  assessment: { score: 100, riskLevel: "PASS", reasons: [], tis: [] },
  latestVerdict: null,
};

const status: StatusPayload = {
  rulesVersion: "4.1.0",
  chains: [{ chainId: 5000, name: "Mantle" }],
  watched: [puff, neverAttested],
};

async function connectedClient() {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server — get_verdict", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns current posture plus the last attested verdict with explorer link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "get_verdict", arguments: { address: puff.address } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      rulesVersion: string;
      current: { score: number; riskLevel: string; reasons: string[]; remediation: Array<{ action: string }> };
      lastAttested: { verdictHash: string; attestationId: string | null; explorerTx: string | null } | null;
    };
    expect(sc.rulesVersion).toBe("4.1.0");
    expect(sc.current.score).toBe(0);
    expect(sc.current.riskLevel).toBe("CRITICAL");
    expect(sc.current.remediation[0].action).toContain("receive library");
    expect(sc.lastAttested?.verdictHash).toBe(puff.latestVerdict!.verdictHash);
    expect(sc.lastAttested?.explorerTx).toContain("sepolia.mantlescan.xyz/tx/0x0d52d82a");
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("CRITICAL");
    expect(text).toContain("Puff");
  });

  it("returns lastAttested: null for an asset that has never been attested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "get_verdict", arguments: { address: neverAttested.address } });
    const sc = res.structuredContent as { lastAttested: unknown; current: { riskLevel: string } };
    expect(sc.lastAttested).toBeNull();
    expect(sc.current.riskLevel).toBe("PASS");
  });

  it("propagates resolver errors (unwatched address) as isError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({
      name: "get_verdict",
      arguments: { address: "0x0000000000000000000000000000000000000002" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("list_fleet");
  });
});
