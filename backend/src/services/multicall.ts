import { encodeFunctionData, decodeAbiParameters, type Address } from "viem";

/**
 * Multicall3 — canonical deployment address, identical on every chain that has it.
 * Verified deployed on ethereum (1), base (8453) and mantle (5000) on 2026-07-19.
 */
export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

/** Default sub-calls per batch. Bounds both the node's eth_call gas exposure
 *  and the per-request payload size. */
export const MULTICALL_CHUNK_SIZE = Number(process.env.MULTICALL_CHUNK_SIZE ?? 50);

export type Call = { target: Address; callData: string };
export type CallResult = { success: boolean; returnData: string };

const AGGREGATE3_ABI = [
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
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const RESULT_PARAMS = [
  {
    type: "tuple[]",
    components: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" },
    ],
  },
] as const;

/**
 * allowFailure is ALWAYS true. This codebase treats a revert as meaningful signal
 * (unreadable ULN config, dormant corridor, blocked pathway); `aggregate` would
 * revert the whole batch and destroy exactly the information the engine reads.
 */
export function encodeAggregate3(calls: Call[]): string {
  return encodeFunctionData({
    abi: AGGREGATE3_ABI,
    functionName: "aggregate3",
    args: [calls.map((c) => ({
      target: c.target,
      allowFailure: true,
      callData: c.callData as `0x${string}`,
    }))],
  });
}

export function decodeAggregate3(returnData: string): CallResult[] {
  const [rows] = decodeAbiParameters(RESULT_PARAMS, returnData as `0x${string}`);
  return (rows as readonly { success: boolean; returnData: string }[]).map((r) => ({
    success: r.success,
    returnData: r.returnData,
  }));
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run `calls` through Multicall3 using the supplied raw-call function, chunked.
 * Takes a call function rather than a client so this module stays free of any
 * RPC-client dependency.
 *
 * Returns one entry per input call, in input order: the data string, or null
 * where that sub-call reverted or returned nothing.
 *
 * THROWS on transport failure. That distinction is load-bearing: callers must
 * be able to tell "the chain said no" (null) from "we failed to ask" (throw).
 * Collapsing the two would let a rate limit read as a revert and suppress a
 * finding.
 */
export async function aggregate3Batch(
  call: (to: Address, data: string) => Promise<string>,
  calls: Call[],
  chunkSize: number = MULTICALL_CHUNK_SIZE,
): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const part of chunk(calls, chunkSize)) {
    const raw = await call(MULTICALL3_ADDRESS, encodeAggregate3(part));
    if (!raw || raw === "0x") throw new Error("empty multicall result");
    for (const r of decodeAggregate3(raw)) {
      out.push(r.success && r.returnData && r.returnData !== "0x" ? r.returnData : null);
    }
  }
  return out;
}

/** Bounded-concurrency map. The fallback paths use this instead of a bare
 *  Promise.all so that a failing batch degrades gracefully rather than
 *  reintroducing the unbounded fan-out this whole change exists to remove. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Concurrency for fallback (non-batched) reads. */
export const FALLBACK_CONCURRENCY = Number(process.env.FALLBACK_CONCURRENCY ?? 4);
