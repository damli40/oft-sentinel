import { describe, it, expect } from "vitest";
import {
  MULTICALL3_ADDRESS,
  encodeAggregate3,
  decodeAggregate3,
  chunk,
  mapLimit,
  aggregate3Batch,
  type Call,
} from "../services/multicall.js";
import { decodeFunctionData, type Address } from "viem";

const A = ("0x" + "11".repeat(20)) as Address;
const B = ("0x" + "22".repeat(20)) as Address;

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
});

describe("encodeAggregate3", () => {
  it("sets allowFailure true on every call", () => {
    const calls: Call[] = [
      { target: A, callData: "0xaabbccdd" },
      { target: B, callData: "0x11223344" },
    ];
    const encoded = encodeAggregate3(calls);

    const abi = [
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

    const { args } = decodeFunctionData({ abi, data: encoded as `0x${string}` });
    const decoded = args![0] as readonly { target: string; allowFailure: boolean; callData: string }[];
    expect(decoded).toHaveLength(2);
    expect(decoded.every((c) => c.allowFailure === true)).toBe(true);
    expect(decoded[0].target.toLowerCase()).toBe(A.toLowerCase());
    expect(decoded[1].callData).toBe("0x11223344");
  });
});

describe("decodeAggregate3", () => {
  it("round-trips success flags and return data in order", async () => {
    // Build an on-the-wire aggregate3 return value.
    const { encodeAbiParameters } = await import("viem");
    const wire = encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "success", type: "bool" },
            { name: "returnData", type: "bytes" },
          ],
        },
      ],
      [[
        { success: true, returnData: "0xdeadbeef" },
        { success: false, returnData: "0x" },
        { success: true, returnData: "0xcafe" },
      ]],
    );

    const out = decodeAggregate3(wire);
    expect(out).toEqual([
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

  it("never exceeds the concurrency limit", async () => {
    let live = 0, peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([] as number[], 4, async (n) => n)).toEqual([]);
  });
});

describe("aggregate3Batch", () => {
  it("maps failed sub-calls to null and keeps order", async () => {
    const { encodeAbiParameters } = await import("viem");
    const call = async () =>
      encodeAbiParameters(
        [{ type: "tuple[]", components: [
          { name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
        [[
          { success: true, returnData: "0xaa" },
          { success: false, returnData: "0x" },
        ]],
      );
    expect(await aggregate3Batch(call, [
      { target: A, callData: "0x01" },
      { target: B, callData: "0x02" },
    ])).toEqual(["0xaa", null]);
  });

  it("propagates a transport failure rather than returning nulls", async () => {
    const call = async (): Promise<string> => { throw new Error("429 Too Many Requests"); };
    await expect(
      aggregate3Batch(call, [{ target: A, callData: "0x01" }]),
    ).rejects.toThrow("429");
  });
});
