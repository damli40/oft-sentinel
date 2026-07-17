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

  it("rejects a malformed snapshot with 400", async () => {
    expect((await post({ snapshot: { oft: "not-an-address", chainId: 5000, routes: [] } })).status).toBe(400);
    expect((await post({ snapshot: snapshot({ routes: "nope" }) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("is pure — validating does not create a verdict", async () => {
    const before = await (await fetch(base.replace("/validate", "/verdicts"))).json();
    await post({ snapshot: snapshot() });
    const after = await (await fetch(base.replace("/validate", "/verdicts"))).json();
    expect(after.verdicts.length).toBe(before.verdicts.length);
  });
});
