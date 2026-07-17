import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getChainRef,
  getChainRefByKey,
  listEligibleChains,
  meetsQuorum,
  distinctProviderCount,
  normalizeProvider,
  _resetChainRegistryCache,
  chainDisplayName,
} from "../services/chain-registry.js";

// Isolated registry fixtures via CHAIN_REGISTRY_PATH; cache reset between tests.
let dir: string;
const savedPath = process.env.CHAIN_REGISTRY_PATH;
const savedMantleRpc = process.env.MANTLE_RPC;
const savedAlchemyKey = process.env.ALCHEMY_API_KEY;
const savedDrpcKey = process.env.DRPC_API_KEY;

function writeRegistry(chains: Record<string, unknown>): string {
  const file = join(dir, "chain-registry.json");
  writeFileSync(file, JSON.stringify({ generatedAt: "x", source: "test", chains }));
  process.env.CHAIN_REGISTRY_PATH = file;
  _resetChainRegistryCache();
  return file;
}

const rpc = (url: string, provider: string) => ({ url, provider });

const twoProviderChain = {
  chainKey: "mantle",
  eid: 30181,
  chainId: 5000,
  eligible: true,
  etherscanFree: true,
  rpcs: [rpc("https://rpc.mantle.xyz", "official"), rpc("https://mantle.drpc.org", "drpc")],
  note: "",
};

const oneProviderChain = {
  chainKey: "solo",
  eid: 39999,
  chainId: 99999,
  eligible: true, // file lies — loader must still mark it ineligible
  etherscanFree: false,
  rpcs: [rpc("https://a.solo.xyz", "official"), rpc("https://b.solo.xyz", "official")],
  note: "single provider",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chainreg-"));
  delete process.env.MANTLE_RPC;
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.DRPC_API_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedPath === undefined) delete process.env.CHAIN_REGISTRY_PATH;
  else process.env.CHAIN_REGISTRY_PATH = savedPath;
  if (savedMantleRpc === undefined) delete process.env.MANTLE_RPC;
  else process.env.MANTLE_RPC = savedMantleRpc;
  if (savedAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = savedAlchemyKey;
  if (savedDrpcKey === undefined) delete process.env.DRPC_API_KEY;
  else process.env.DRPC_API_KEY = savedDrpcKey;
  _resetChainRegistryCache();
});

describe("provider normalization + quorum rule", () => {
  it("normalizes labels (lowercase, strip other-, collapse thirdweb)", () => {
    expect(normalizeProvider("DRPC")).toBe("drpc");
    expect(normalizeProvider("other-thirdweb")).toBe("thirdweb");
    expect(normalizeProvider("thirdweb")).toBe("thirdweb");
    expect(normalizeProvider("42161.rpc.thirdweb.com")).toBe("thirdweb");
    expect(normalizeProvider("other-nodies")).toBe("nodies");
  });

  it("counts distinct providers after normalization", () => {
    expect(distinctProviderCount([rpc("a", "thirdweb"), rpc("b", "other-thirdweb")])).toBe(1);
    expect(distinctProviderCount([rpc("a", "drpc"), rpc("b", "official")])).toBe(2);
  });

  it("requires >=2 rpcs from >=2 distinct providers", () => {
    expect(meetsQuorum([rpc("a", "drpc")])).toBe(false); // one endpoint
    expect(meetsQuorum([rpc("a", "official"), rpc("b", "official")])).toBe(false); // same provider
    expect(meetsQuorum([rpc("a", "official"), rpc("b", "drpc")])).toBe(true);
  });
});

describe("registry lookups", () => {
  beforeEach(() => writeRegistry({ mantle: twoProviderChain, solo: oneProviderChain }));

  it("looks up by chainId", () => {
    expect(getChainRef(5000)?.chainKey).toBe("mantle");
    expect(getChainRef(123456)).toBeNull();
  });

  it("looks up by chainKey", () => {
    expect(getChainRefByKey("mantle")?.chainId).toBe(5000);
    expect(getChainRefByKey("nope")).toBeNull();
  });

  it("marks a single-provider chain ineligible even if the file says eligible", () => {
    expect(getChainRef(99999)?.eligible).toBe(false);
    expect(getChainRef(5000)?.eligible).toBe(true);
  });

  it("listEligibleChains excludes chains that fail the quorum rule", () => {
    const keys = listEligibleChains().map((c) => c.chainKey);
    expect(keys).toContain("mantle");
    expect(keys).not.toContain("solo");
  });
});

describe("MANTLE_RPC override", () => {
  it("promotes MANTLE_RPC to rpcs[0] for chainId 5000 and dedups", () => {
    process.env.MANTLE_RPC = "https://custom-mantle.example/rpc";
    writeRegistry({ mantle: twoProviderChain });
    const ref = getChainRef(5000)!;
    expect(ref.rpcs[0].url).toBe("https://custom-mantle.example/rpc");
    // Original URLs still present, no duplicate.
    expect(ref.rpcs.filter((r) => r.url === "https://custom-mantle.example/rpc").length).toBe(1);
    expect(ref.rpcs.some((r) => r.url === "https://rpc.mantle.xyz")).toBe(true);
  });

  it("does not reorder when MANTLE_RPC already matches rpcs[0]", () => {
    process.env.MANTLE_RPC = "https://rpc.mantle.xyz";
    writeRegistry({ mantle: twoProviderChain });
    const ref = getChainRef(5000)!;
    expect(ref.rpcs[0].url).toBe("https://rpc.mantle.xyz");
    expect(ref.rpcs.length).toBe(2);
  });
});

describe("keyed provider overrides (ALCHEMY_API_KEY / DRPC_API_KEY)", () => {
  const ethChain = {
    chainKey: "ethereum",
    eid: 30101,
    chainId: 1,
    eligible: true,
    etherscanFree: true,
    rpcs: [rpc("https://eth.merkle.io", "meowrpc"), rpc("https://ethereum-rpc.publicnode.com", "publicnode")],
    note: "",
  };

  it("prepends a keyed alchemy endpoint for mapped chains, publics preserved behind it", () => {
    process.env.ALCHEMY_API_KEY = "testkey";
    writeRegistry({ ethereum: ethChain });
    const ref = getChainRef(1)!;
    expect(ref.rpcs[0]).toEqual({ url: "https://eth-mainnet.g.alchemy.com/v2/testkey", provider: "alchemy" });
    expect(ref.rpcs.some((r) => r.url === "https://eth.merkle.io")).toBe(true);
    expect(ref.rpcs.some((r) => r.url === "https://ethereum-rpc.publicnode.com")).toBe(true);
  });

  it("prepends a keyed drpc endpoint using the drpc network slug", () => {
    process.env.DRPC_API_KEY = "dkey";
    const baseChain = { ...ethChain, chainKey: "base", eid: 30184, chainId: 8453 };
    writeRegistry({ base: baseChain });
    const ref = getChainRef(8453)!;
    expect(ref.rpcs[0]).toEqual({ url: "https://lb.drpc.live/base/dkey", provider: "drpc" });
  });

  it("with both keys set, order is alchemy (primary) then drpc (first quorum peer)", () => {
    process.env.ALCHEMY_API_KEY = "akey";
    process.env.DRPC_API_KEY = "dkey";
    writeRegistry({ ethereum: ethChain });
    const ref = getChainRef(1)!;
    expect(ref.rpcs[0].provider).toBe("alchemy");
    expect(ref.rpcs[1]).toEqual({ url: "https://lb.drpc.live/ethereum/dkey", provider: "drpc" });
    expect(ref.rpcs.length).toBe(4);
  });

  it("leaves unmapped chains untouched even when keys are set", () => {
    process.env.ALCHEMY_API_KEY = "akey";
    process.env.DRPC_API_KEY = "dkey";
    writeRegistry({ solo: oneProviderChain });
    const ref = getChainRef(99999)!;
    expect(ref.rpcs.map((r) => r.provider)).toEqual(["official", "official"]);
  });

  it("is a no-op when neither key is set", () => {
    writeRegistry({ ethereum: ethChain });
    const ref = getChainRef(1)!;
    expect(ref.rpcs.length).toBe(2);
    expect(ref.rpcs[0].provider).toBe("meowrpc");
  });

  it("MANTLE_RPC still wins rpcs[0] on mantle when keys are also set", () => {
    process.env.ALCHEMY_API_KEY = "akey";
    process.env.MANTLE_RPC = "https://custom-mantle.example/rpc";
    writeRegistry({ mantle: twoProviderChain });
    const ref = getChainRef(5000)!;
    expect(ref.rpcs[0].url).toBe("https://custom-mantle.example/rpc");
    expect(ref.rpcs.some((r) => r.url === "https://mantle-mainnet.g.alchemy.com/v2/akey")).toBe(true);
  });

  it("does not duplicate a keyed URL already present in the registry file", () => {
    process.env.ALCHEMY_API_KEY = "akey";
    const withKeyed = {
      ...ethChain,
      rpcs: [rpc("https://eth-mainnet.g.alchemy.com/v2/akey", "alchemy"), rpc("https://eth.merkle.io", "meowrpc")],
    };
    writeRegistry({ ethereum: withKeyed });
    const ref = getChainRef(1)!;
    expect(ref.rpcs.filter((r) => r.url.includes("alchemy")).length).toBe(1);
  });

  it("keyed providers count toward the quorum invariant", () => {
    // One distinct public provider — ineligible on file rpcs alone; the keyed
    // endpoint is a real second provider, so quorum is genuinely met.
    process.env.ALCHEMY_API_KEY = "akey";
    const thin = { ...ethChain, rpcs: [rpc("https://eth.merkle.io", "meowrpc")] };
    writeRegistry({ ethereum: thin });
    expect(getChainRef(1)?.eligible).toBe(true);
  });

  it("a thin chain stays ineligible without a key", () => {
    const thin = { ...ethChain, rpcs: [rpc("https://eth.merkle.io", "meowrpc")] };
    writeRegistry({ ethereum: thin });
    expect(getChainRef(1)?.eligible).toBe(false);
  });
});

describe("missing / malformed file", () => {
  it("throws when the registry file is missing", () => {
    process.env.CHAIN_REGISTRY_PATH = join(dir, "does-not-exist.json");
    _resetChainRegistryCache();
    expect(() => getChainRef(5000)).toThrow(/cannot read\/parse/);
  });

  it("throws when the registry is malformed (no chains)", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ nope: true }));
    process.env.CHAIN_REGISTRY_PATH = file;
    _resetChainRegistryCache();
    expect(() => getChainRef(5000)).toThrow(/malformed/);
  });
});

describe("chainDisplayName", () => {
  it("capitalizes a plain chainKey", () => {
    expect(chainDisplayName("ethereum")).toBe("Ethereum");
    expect(chainDisplayName("base")).toBe("Base");
    expect(chainDisplayName("mantle")).toBe("Mantle");
  });

  it("uses the accepted spelling where capitalization is wrong", () => {
    expect(chainDisplayName("bsc")).toBe("BNB Chain");
    expect(chainDisplayName("zksync")).toBe("zkSync");
    expect(chainDisplayName("opbnb")).toBe("opBNB");
  });

  it("never throws on missing input", () => {
    expect(chainDisplayName(null)).toBe("Unknown");
    expect(chainDisplayName(undefined)).toBe("Unknown");
  });
});
