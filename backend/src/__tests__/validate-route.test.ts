import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "http";
import type { AddressInfo } from "net";

// assessSnapshot calls loadDvnMeta() (network) — stub only that, same pattern
// as dead-dvn.test.ts. Everything else in the engine runs for real.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "validate-route-"));

import { router } from "../routes/sentinel.js";

const REAL_DVN = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b";
const OFT = "0xabc1111111111111111111111111111111111111";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/sentinel", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sentinel/validate`;
});

afterAll(() => server.close());

function route(over: Record<string, unknown> = {}) {
  return {
    eid: 30101,
    chainName: "ethereum",
    chainKey: "ethereum",
    sendLibrary: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
    sendLibIsDefault: true,
    receiveLibrary: "0x0000000000000000000000000000000000000001",
    receiveLibIsDefault: true,
    uln: {
      confirmations: 64,
      requiredDVNCount: 1,
      requiredDVNs: [REAL_DVN],
      optionalDVNCount: 0,
      optionalDVNThreshold: 0,
      optionalDVNs: [],
    },
    receiveUln: null,
    peer: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    peerAddress: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    hasEnforcedOptions: null,
    isActive: true,
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    oft: OFT,
    chainId: 5000,
    capturedAt: 1700000000000,
    owner: "0x1234567890123456789012345678901234567890",
    ownerIsContract: false,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes: [route()],
    ...over,
  };
}

function post(body: unknown) {
  return fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/sentinel/validate", () => {
  it("scores a 1-of-1 DVN config CRITICAL — the Kelp shape", async () => {
    const res = await post({ snapshot: snapshot() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskLevel).toBe("CRITICAL");
    expect(typeof body.score).toBe("number");
    expect(body.rulesVersion).toBe("4.1.0");
    expect(body.findings.some((f: { check: string; severity: string }) => /dvn/i.test(f.check) && f.severity === "CRITICAL")).toBe(true);
    expect(Array.isArray(body.tis)).toBe(true);
  });

  it("consumes a custody declaration — same config, different findings", async () => {
    const bare = await (await post({ snapshot: snapshot() })).json();
    const declared = await (await post({
      snapshot: snapshot(),
      custodyDeclaration: { custodyType: "fireblocks_mpc", declaredBy: "team (relayed)" },
    })).json();
    expect(JSON.stringify(declared.findings)).not.toEqual(JSON.stringify(bare.findings));
    expect(declared.score).toBeGreaterThanOrEqual(bare.score);
  });

  it("rejects more than 30 routes with 400", async () => {
    const routes = Array.from({ length: 31 }, (_, i) => route({ eid: 30000 + i }));
    const res = await post({ snapshot: snapshot({ routes }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/routes/i);
  });

  // OKX's escrow re-test (Jul 21): a buyer pastes the config a human actually
  // holds — ticker, routes with chain names, DVNs, confirmations — and no
  // contract address. That paste must produce a real verdict, not a 400.
  it("scores a buyer paste with no OFT address — the OKX MYTKN shape", async () => {
    const res = await post({
      snapshot: {
        token: "MYTKN",
        routes: [{
          chainName: "ethereum",
          dvns: [REAL_DVN],
          confirmations: 20,
          libraries: { send: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2", receive: "0x0000000000000000000000000000000000000001" },
        }],
      },
      ticker: "MYTKN",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskLevel).toBe("CRITICAL"); // 1-of-1 DVN still fires on the lifted ULN
    expect(body.findings.some((f: { check: string }) => /oft address/i.test(f.check))).toBe(true);
    const advisory = body.findings.find((f: { check: string }) => /oft address/i.test(f.check));
    expect(advisory.severity).toBe("UNKNOWN");
    expect(advisory.evidence).toBe("unverifiable");
  });

  it("resolves route chain names to eids and flags an unknown source chain", async () => {
    const res = await post({
      snapshot: { oft: OFT, routes: [route({ eid: undefined, chainName: "ethereum" })] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskLevel).toBe("CRITICAL");
    expect(body.findings.some((f: { check: string }) => /source chain/i.test(f.check))).toBe(true);
  });

  it("validates top-level dvns/confirmations as a single synthesized route", async () => {
    const res = await post({ snapshot: { dvns: [REAL_DVN], confirmations: 20 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskLevel).toBe("CRITICAL"); // 1-of-1
    expect(body.findings.some((f: { check: string }) => /routes/i.test(f.check))).toBe(true);
  });

  it("answers an unscoreable config with a plain-language 200, never a raw 400", async () => {
    for (const snap of [{}, { oft: "not-an-address", chainId: 5000, routes: [] }, snapshot({ routes: "nope" })]) {
      const res = await post({ snapshot: snap });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.incomplete).toBe(true);
      expect(body.riskLevel).toBeNull();
      expect(body.message).toMatch(/routes/i);
      expect(body.missing).toContain("routes");
      expect(body.rulesVersion).toBe("4.1.0");
    }
  });

  it("answers unpaid snapshot-less requests with an x402 challenge", async () => {
    for (const res of [await fetch(base), await post({})]) {
      expect(res.status).toBe(402);
      const header = res.headers.get("payment-required");
      expect(header).toBeTruthy();
      const challenge = JSON.parse(Buffer.from(header!, "base64").toString());
      expect(challenge.x402Version).toBe(2);
      expect(challenge.accepts).toHaveLength(1);
      // 0.01 USDT at 6 decimals. A zero amount is valid x402 but OKX's buyer-side
      // task-402-pay cannot convert "0 USDT" to minimal units (their Jul 21 report),
      // so the listed fee and this challenge both carry 0.01.
      expect(challenge.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:196", amount: "10000" });
    }
  });

  it("serves a paid replay; a paid replay with no config gets a usable explanation", async () => {
    const paid = (body: unknown) =>
      fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "payment-signature": "signed-by-okx-escrow" },
        body: JSON.stringify(body),
      });
    expect((await paid({ snapshot: snapshot() })).status).toBe(200);
    const empty = await paid({});
    expect(empty.status).toBe(200);
    const body = await empty.json();
    expect(body.incomplete).toBe(true);
    expect(body.message).toMatch(/config/i);
  });

  it("is pure — validating does not create a verdict", async () => {
    const before = await (await fetch(base.replace("/validate", "/verdicts"))).json();
    await post({ snapshot: snapshot() });
    const after = await (await fetch(base.replace("/validate", "/verdicts"))).json();
    expect(after.verdicts.length).toBe(before.verdicts.length);
  });
});
