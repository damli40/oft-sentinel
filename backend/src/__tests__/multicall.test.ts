import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MULTICALL3_ADDRESS,
  encodeAggregate3,
  decodeAggregate3,
  chunk,
  mapLimit,
  aggregate3Batch,
  type Call,
} from "../services/multicall.js";
import {
  decodeFunctionData,
  encodeAbiParameters,
  type Address,
} from "viem";

const A = ("0x" + "11".repeat(20)) as Address;
const B = ("0x" + "22".repeat(20)) as Address;

/** ABI used only to inspect what the implementation produced. */
const INSPECT_ABI = [
  {
    name: "aggregate3",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const RESULT_TUPLE = [
  {
    type: "tuple[]",
    components: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" },
    ],
  },
] as const;

/** Build an on-the-wire aggregate3 return value. */
function encodeResults(rows: { success: boolean; returnData: string }[]): string {
  return encodeAbiParameters(RESULT_TUPLE, [
    rows.map((r) => ({ success: r.success, returnData: r.returnData as `0x${string}` })),
  ]);
}

function decodeCalls(data: string) {
  const { args } = decodeFunctionData({ abi: INSPECT_ABI, data: data as `0x${string}` });
  return args![0] as readonly {
    target: string;
    allowFailure: boolean;
    callData: string;
  }[];
}

describe("MULTICALL3_ADDRESS", () => {
  it("is the canonical address", () => {
    expect(MULTICALL3_ADDRESS.toLowerCase()).toBe(
      "0xca11bde05977b3631167028862be2a173976ca11",
    );
  });
});

describe("chunk", () => {
  it("returns no chunks for an empty list", () => {
    expect(chunk([], 50)).toEqual([]);
  });

  it("returns one chunk when the list is shorter than the size", () => {
    expect(chunk([1], 50)).toEqual([[1]]);
  });

  it("returns one chunk at exactly the size", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(chunk(items, 50)).toHaveLength(1);
  });

  it("splits at size + 1", () => {
    const items = Array.from({ length: 51 }, (_, i) => i);
    const out = chunk(items, 50);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual([50]);
  });

  it("preserves order and completeness across many chunks", () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    const out = chunk(items, 50);
    expect(out).toHaveLength(3);
    expect(out.flat()).toEqual(items);
  });

  it("throws on a zero or negative size rather than looping or returning nothing", () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow("chunk size must be positive");
    expect(() => chunk([1, 2, 3], -1)).toThrow("chunk size must be positive");
  });
});

/**
 * GOLDEN VECTORS — frozen fixtures, NOT computed at test time.
 *
 * These byte strings were produced once by encoding with viem and pasted here as
 * literals. They exist because every other encode/decode test in this file is
 * closed-loop: it re-declares the tuple spec and round-trips through the
 * implementation's own copy, so swapping `allowFailure` and `callData` in both
 * copies would keep those tests green while breaking production. A hardcoded
 * expectation cannot follow the implementation when the implementation is wrong.
 *
 * Do not regenerate these from the implementation to make a failing test pass.
 * A diff here means the wire format changed, which is a production bug until
 * proven otherwise. The layout is hand-checkable against the ABI spec:
 * `aggregate3((address,bool,bytes)[])`, selector 0x82ad56cb.
 */
const GOLDEN_CALLDATA =
  "0x" +
  // selector: keccak256("aggregate3((address,bool,bytes)[])")[0:4]
  "82ad56cb" +
  [
    "0000000000000000000000000000000000000000000000000000000000000020", // offset to calls[]
    "0000000000000000000000000000000000000000000000000000000000000002", // calls.length = 2
    "0000000000000000000000000000000000000000000000000000000000000040", // offset -> calls[0]
    "00000000000000000000000000000000000000000000000000000000000000e0", // offset -> calls[1]
    "0000000000000000000000001111111111111111111111111111111111111111", // [0].target = A
    "0000000000000000000000000000000000000000000000000000000000000001", // [0].allowFailure = true
    "0000000000000000000000000000000000000000000000000000000000000060", // [0] offset -> callData
    "0000000000000000000000000000000000000000000000000000000000000004", // [0].callData.length = 4
    "aabbccdd00000000000000000000000000000000000000000000000000000000", // [0].callData
    "0000000000000000000000002222222222222222222222222222222222222222", // [1].target = B
    "0000000000000000000000000000000000000000000000000000000000000001", // [1].allowFailure = true
    "0000000000000000000000000000000000000000000000000000000000000060", // [1] offset -> callData
    "0000000000000000000000000000000000000000000000000000000000000004", // [1].callData.length = 4
    "1122334400000000000000000000000000000000000000000000000000000000", // [1].callData
  ].join("");

const GOLDEN_RETURN =
  "0x" +
  [
    "0000000000000000000000000000000000000000000000000000000000000020", // offset to returnData[]
    "0000000000000000000000000000000000000000000000000000000000000003", // length = 3
    "0000000000000000000000000000000000000000000000000000000000000060", // offset -> [0]
    "00000000000000000000000000000000000000000000000000000000000000e0", // offset -> [1]
    "0000000000000000000000000000000000000000000000000000000000000140", // offset -> [2]
    "0000000000000000000000000000000000000000000000000000000000000001", // [0].success = true
    "0000000000000000000000000000000000000000000000000000000000000040", // [0] offset -> returnData
    "0000000000000000000000000000000000000000000000000000000000000004", // [0].returnData.length
    "deadbeef00000000000000000000000000000000000000000000000000000000", // [0].returnData
    "0000000000000000000000000000000000000000000000000000000000000000", // [1].success = false
    "0000000000000000000000000000000000000000000000000000000000000040", // [1] offset -> returnData
    "0000000000000000000000000000000000000000000000000000000000000000", // [1].returnData.length = 0
    "0000000000000000000000000000000000000000000000000000000000000001", // [2].success = true
    "0000000000000000000000000000000000000000000000000000000000000040", // [2] offset -> returnData
    "0000000000000000000000000000000000000000000000000000000000000002", // [2].returnData.length
    "cafe000000000000000000000000000000000000000000000000000000000000", // [2].returnData
  ].join("");

describe("golden vectors", () => {
  it("encodes the frozen aggregate3 calldata byte for byte", () => {
    const calls: Call[] = [
      { target: A, callData: "0xaabbccdd" },
      { target: B, callData: "0x11223344" },
    ];
    expect(encodeAggregate3(calls)).toBe(GOLDEN_CALLDATA);
  });

  it("starts every batch with the canonical aggregate3 selector", () => {
    expect(encodeAggregate3([{ target: A, callData: "0x01" }]).slice(0, 10)).toBe(
      "0x82ad56cb",
    );
  });

  it("decodes the frozen aggregate3 return payload", () => {
    expect(decodeAggregate3(GOLDEN_RETURN)).toEqual([
      { success: true, returnData: "0xdeadbeef" },
      { success: false, returnData: "0x" },
      { success: true, returnData: "0xcafe" },
    ]);
  });
});

describe("encodeAggregate3", () => {
  it("sets allowFailure true on every call", () => {
    const calls: Call[] = [
      { target: A, callData: "0xaabbccdd" },
      { target: B, callData: "0x11223344" },
    ];
    const decoded = decodeCalls(encodeAggregate3(calls));
    expect(decoded).toHaveLength(2);
    expect(decoded.every((c) => c.allowFailure === true)).toBe(true);
    expect(decoded[0].target.toLowerCase()).toBe(A.toLowerCase());
    expect(decoded[1].callData).toBe("0x11223344");
  });
});

describe("decodeAggregate3", () => {
  it("round-trips success flags and return data in order", () => {
    const wire = encodeResults([
      { success: true, returnData: "0xdeadbeef" },
      { success: false, returnData: "0x" },
      { success: true, returnData: "0xcafe" },
    ]);

    expect(decodeAggregate3(wire)).toEqual([
      { success: true, returnData: "0xdeadbeef" },
      { success: false, returnData: "0x" },
      { success: true, returnData: "0xcafe" },
    ]);
  });
});

describe("mapLimit", () => {
  it("preserves order and returns one result per input", async () => {
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("reaches the concurrency limit and never exceeds it", async () => {
    let live = 0, peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
    });
    // Exactly 3: `<= 3` alone would also pass for a fully serial implementation.
    expect(peak).toBe(3);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([] as number[], 4, async (n) => n)).toEqual([]);
  });

  it.each([0, -1, NaN, Infinity])(
    "throws on a limit of %s rather than returning a hole-filled array",
    async (limit) => {
      const fn = vi.fn(async (n: number) => n * 2);
      await expect(mapLimit([1, 2, 3], limit, fn)).rejects.toThrow(
        /concurrency must be >= 1/,
      );
      // The silent-failure shape: zero workers, no work done, array of undefined.
      expect(fn).not.toHaveBeenCalled();
    },
  );
});

describe("aggregate3Batch", () => {
  it("maps failed sub-calls to null and keeps order", async () => {
    const call = async () =>
      encodeResults([
        { success: true, returnData: "0xaa" },
        { success: false, returnData: "0x" },
      ]);
    expect(await aggregate3Batch(call, [
      { target: A, callData: "0x01" },
      { target: B, callData: "0x02" },
    ])).toEqual(["0xaa", null]);
  });

  it("sends the batch to MULTICALL3_ADDRESS with the encoded payload", async () => {
    const seen: { to: Address; data: string }[] = [];
    const calls: Call[] = [
      { target: A, callData: "0x01" },
      { target: B, callData: "0x02" },
    ];
    const call = async (to: Address, data: string) => {
      seen.push({ to, data });
      return encodeResults([
        { success: true, returnData: "0xaa" },
        { success: true, returnData: "0xbb" },
      ]);
    };

    await aggregate3Batch(call, calls);

    expect(seen).toHaveLength(1);
    expect(seen[0].to).toBe(MULTICALL3_ADDRESS);
    expect(seen[0].data).toBe(encodeAggregate3(calls));
    // And independently of the implementation's encoder: the payload really does
    // carry both sub-calls, at the right targets, in input order.
    const decoded = decodeCalls(seen[0].data);
    expect(decoded.map((c) => c.target.toLowerCase())).toEqual([
      A.toLowerCase(),
      B.toLowerCase(),
    ]);
    expect(decoded.map((c) => c.callData)).toEqual(["0x01", "0x02"]);
  });

  it("splits into multiple batches and concatenates results in input order", async () => {
    const calls: Call[] = Array.from({ length: 5 }, (_, i) => ({
      target: i % 2 === 0 ? A : B,
      callData: `0x0${i}`,
    }));
    const payloads: string[] = [];

    const call = async (_to: Address, data: string) => {
      payloads.push(data);
      // Answer with one row per sub-call actually present in this batch, echoing
      // the sub-call's own calldata so a reordering or chunk mix-up is visible.
      return encodeResults(
        decodeCalls(data).map((c) => ({ success: true, returnData: c.callData })),
      );
    };

    const out = await aggregate3Batch(call, calls, 2);

    // 5 calls at chunkSize 2 => 3 invocations, not 1.
    expect(payloads).toHaveLength(3);
    expect(payloads.map((p) => decodeCalls(p).length)).toEqual([2, 2, 1]);
    expect(payloads.map((p) => decodeCalls(p).map((c) => c.callData))).toEqual([
      ["0x00", "0x01"],
      ["0x02", "0x03"],
      ["0x04"],
    ]);
    // Full ordered output across every chunk boundary.
    expect(out).toEqual(["0x00", "0x01", "0x02", "0x03", "0x04"]);
  });

  it("throws when the node returns fewer rows than sub-calls", async () => {
    const call = async () => encodeResults([{ success: true, returnData: "0xaa" }]);
    await expect(
      aggregate3Batch(call, [
        { target: A, callData: "0x01" },
        { target: B, callData: "0x02" },
        { target: A, callData: "0x03" },
      ]),
    ).rejects.toThrow("multicall returned 1 results for 3 calls");
  });

  it("throws when the node returns more rows than sub-calls", async () => {
    // 5 inputs at chunkSize 2 against a responder that always returns 2 rows:
    // the final 1-call chunk over-fills, so index i stops matching input i.
    const call = async () =>
      encodeResults([
        { success: true, returnData: "0xaa" },
        { success: true, returnData: "0xbb" },
      ]);
    const calls: Call[] = Array.from({ length: 5 }, (_, i) => ({
      target: A,
      callData: `0x0${i}`,
    }));
    await expect(aggregate3Batch(call, calls, 2)).rejects.toThrow(
      "multicall returned 2 results for 1 calls",
    );
  });

  it("throws on an empty response rather than reporting no results", async () => {
    for (const empty of ["0x", ""]) {
      const call = async () => empty;
      await expect(
        aggregate3Batch(call, [{ target: A, callData: "0x01" }]),
      ).rejects.toThrow("empty multicall result");
    }
  });

  it("propagates a transport failure rather than returning nulls", async () => {
    const call = async (): Promise<string> => { throw new Error("429 Too Many Requests"); };
    await expect(
      aggregate3Batch(call, [{ target: A, callData: "0x01" }]),
    ).rejects.toThrow("429");
  });
});

describe("env configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = () => import("../services/multicall.js");

  it("uses the documented defaults when unset", async () => {
    vi.stubEnv("MULTICALL_CHUNK_SIZE", undefined);
    vi.stubEnv("FALLBACK_CONCURRENCY", undefined);
    vi.resetModules();
    const m = await load();
    expect(m.MULTICALL_CHUNK_SIZE).toBe(50);
    expect(m.FALLBACK_CONCURRENCY).toBe(4);
  });

  it("accepts a valid override", async () => {
    vi.stubEnv("MULTICALL_CHUNK_SIZE", "25");
    vi.stubEnv("FALLBACK_CONCURRENCY", "8");
    vi.resetModules();
    const m = await load();
    expect(m.MULTICALL_CHUNK_SIZE).toBe(25);
    expect(m.FALLBACK_CONCURRENCY).toBe(8);
  });

  it.each(["", "fifty", "0", "-1", "2.5", "NaN"])(
    "fails loudly at import on MULTICALL_CHUNK_SIZE=\"%s\"",
    async (bad) => {
      vi.stubEnv("MULTICALL_CHUNK_SIZE", bad);
      vi.resetModules();
      await expect(load()).rejects.toThrow(/MULTICALL_CHUNK_SIZE must be a positive integer/);
    },
  );

  it.each(["", "four", "0", "-2", "1.5"])(
    "fails loudly at import on FALLBACK_CONCURRENCY=\"%s\"",
    async (bad) => {
      vi.stubEnv("FALLBACK_CONCURRENCY", bad);
      vi.resetModules();
      await expect(load()).rejects.toThrow(/FALLBACK_CONCURRENCY must be a positive integer/);
    },
  );
});
