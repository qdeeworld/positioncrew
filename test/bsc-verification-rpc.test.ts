import { afterEach, describe, expect, it, vi } from "vitest";
import { bscReadRpcFallbacks } from "../src/telemetry/bsc.js";
import { createBscVerificationRpc } from "../src/marketplace/bsc-verification-rpc.js";

const primary = "https://bsc-rpc.publicnode.com";
const pinnedCall = [{ to: "0x0000000000000000000000000000000000000001", data: "0x12345678" }, "0x7170000"];
const response = (result: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));

afterEach(() => { vi.useRealTimers(); });

describe("bounded BSC verification transport", () => {
  it("falls back after 429 without changing the method or pinned block", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return String(input) === primary ? new Response(null, { status: 429 }) : response("0x1234");
    };
    await expect(createBscVerificationRpc(primary, fetchImpl).request("eth_call", pinnedCall)).resolves.toBe("0x1234");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual(calls[1]?.body);
    expect(calls[1]?.body).toMatchObject({ method: "eth_call", params: pinnedCall });
    expect(bscReadRpcFallbacks(primary)).toContain(calls[1]?.url);
  });

  it("reuses a working fallback for subsequent reads in the same verification", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return String(input) === primary ? new Response(null, { status: 503 }) : response("0x1234");
    };
    const rpc = createBscVerificationRpc(primary, fetchImpl);
    await rpc.request("eth_blockNumber", []);
    await rpc.request("eth_call", pinnedCall);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toBe(urls[2]);
    expect(urls[2]).not.toBe(primary);
  });

  it("falls back on transport rejection but never retries an EVM execution rejection", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      return response("0x1234");
    };
    await expect(createBscVerificationRpc(primary, fetchImpl).request("eth_call", pinnedCall)).resolves.toBe("0x1234");
    expect(calls).toBe(2);
    calls = 0;
    const rejected: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }));
    };
    await expect(createBscVerificationRpc(primary, rejected).request("eth_call", pinnedCall)).rejects.toThrow("execution reverted");
    expect(calls).toBe(1);
  });

  it("does not retry non-transient HTTP failures or mismatched response identity", async () => {
    for (const failure of [() => new Response(null, { status: 422 }),
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "0x1234" }))]) {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => { calls += 1; return failure(); };
      await expect(createBscVerificationRpc(primary, fetchImpl).request("eth_blockNumber", [])).rejects.toThrow("verification RPC unavailable");
      expect(calls).toBe(1);
    }
  });

  it("bounds attempts when every approved endpoint is rate limited", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => { urls.push(String(input)); return new Response(null, { status: 429 }); };
    await expect(createBscVerificationRpc(primary, fetchImpl).request("eth_blockNumber", [])).rejects.toThrow("HTTP 429");
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.length).toBeLessThanOrEqual(3);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((url) => bscReadRpcFallbacks(primary).includes(url))).toBe(true);
  });

  it("enforces an overall deadline even if fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => {});
    };
    const pending = createBscVerificationRpc(primary, fetchImpl, { timeoutMs: 15, attemptTimeoutMs: 10 }).request("eth_blockNumber", []);
    const rejected = expect(pending).rejects.toThrow("verification RPC unavailable");
    await vi.advanceTimersByTimeAsync(16);
    await rejected;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("honors caller cancellation without beginning fallback requests", async () => {
    const caller = new AbortController();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    const pending = createBscVerificationRpc(primary, fetchImpl, { signal: caller.signal }).request("eth_blockNumber", []);
    const rejected = expect(pending).rejects.toThrow("Caller cancelled verification");
    caller.abort();
    await rejected;
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
  });

  it("rejects mutations and unpinned calls before touching a transport", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls += 1; return response("0x1234"); };
    const rpc = createBscVerificationRpc(primary, fetchImpl);
    await expect(rpc.request("eth_sendRawTransaction" as never, ["0x1234"])).rejects.toThrow("Only block-number reads");
    await expect(rpc.request("eth_call", [pinnedCall[0], "latest"])).rejects.toThrow("explicitly block-pinned");
    expect(calls).toBe(0);
  });
});
