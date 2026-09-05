import { bscReadRpcFallbacks } from "../telemetry/bsc.js";

type ReadMethod = "eth_blockNumber" | "eth_call";

export class BscPositionVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BscPositionVerificationError";
  }
}

export class BscVerificationRpcError extends BscPositionVerificationError {
  constructor(detail: string) {
    super(`PositionCrew BSC position verification RPC unavailable: ${detail}`);
    this.name = "BscVerificationRpcError";
  }
}

class AttemptError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export interface BscVerificationRpc {
  request(method: ReadMethod, params: unknown[]): Promise<string>;
}

/** Read-only prerequisite transport, never a retry wrapper for provider calls. */
export function createBscVerificationRpc(
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: { signal?: AbortSignal; timeoutMs?: number; attemptTimeoutMs?: number } = {},
): BscVerificationRpc {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 1_200;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 4_000 ||
      !Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0 || attemptTimeoutMs > 1_200) {
    throw new BscVerificationRpcError("Invalid bounded transport deadline");
  }
  // Reuse the telemetry allowlist, including its custom-RPC isolation behavior.
  const candidates = [...new Set(bscReadRpcFallbacks(rpcUrl))].slice(0, 3);
  const deadline = Date.now() + timeoutMs;
  let preferred = candidates[0];

  async function attempt(url: string, method: ReadMethod, params: unknown[], milliseconds: number): Promise<string> {
    const controller = new AbortController();
    const callerAborted = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", callerAborted, { once: true });
    if (options.signal?.aborted) callerAborted();
    const timer = setTimeout(() => controller.abort(new Error("RPC attempt timed out")), milliseconds);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AttemptError(
        options.signal?.aborted ? "Caller cancelled verification" : "RPC attempt timed out",
        !options.signal?.aborted,
      ));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try {
      const operation = async (): Promise<string> => {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
        } catch {
          throw new AttemptError("RPC transport failed", !options.signal?.aborted);
        }
        if (!response.ok) {
          throw new AttemptError(`HTTP ${response.status}`,
            response.status === 408 || response.status === 429 || response.status >= 500);
        }
        let value: unknown;
        try { value = await response.json(); }
        catch { throw new AttemptError("Malformed RPC JSON", true); }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new AttemptError("Invalid RPC envelope", false);
        }
        const payload = value as Record<string, unknown>;
        if (payload.jsonrpc !== "2.0" || payload.id !== 1) {
          throw new AttemptError("RPC response identity mismatch", false);
        }
        if (payload.error !== undefined) {
          const error = payload.error as { code?: unknown; message?: unknown } | null;
          const code = error?.code;
          const message = typeof error?.message === "string" ? error.message.slice(0, 160) : "RPC rejected read";
          const retryable = code === -32002 || code === -32005 || code === -32603 ||
            (code === -32000 && /busy|gateway|header not found|rate limit|temporar|timeout/i.test(message));
          throw new AttemptError(`RPC ${String(code)}: ${message}`, retryable);
        }
        if (typeof payload.result !== "string" || !/^0x[\da-f]*$/i.test(payload.result)) {
          throw new AttemptError("Invalid RPC result", false);
        }
        return payload.result;
      };
      return await Promise.race([operation(), aborted]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", callerAborted);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  return {
    async request(method, params) {
      if ((method !== "eth_blockNumber" && method !== "eth_call") ||
          (method === "eth_blockNumber" && params.length !== 0) ||
          (method === "eth_call" && (params.length !== 2 ||
            typeof params[1] !== "string" || !/^0x[\da-f]+$/i.test(params[1])))) {
        throw new BscVerificationRpcError("Only block-number reads and explicitly block-pinned eth_call are allowed");
      }
      const failures: string[] = [];
      const ordered = preferred ? [preferred, ...candidates.filter((candidate) => candidate !== preferred)] : [];
      for (const candidate of ordered) {
        if (options.signal?.aborted) throw new BscVerificationRpcError("Caller cancelled verification");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new BscVerificationRpcError("Overall verification deadline exceeded");
        try {
          const result = await attempt(candidate, method, params, Math.min(attemptTimeoutMs, remaining));
          preferred = candidate;
          return result;
        } catch (error) {
          if (!(error instanceof AttemptError)) throw error;
          failures.push(error.message);
          if (!error.retryable || options.signal?.aborted) {
            throw new BscVerificationRpcError(error.message);
          }
        }
      }
      throw new BscVerificationRpcError(failures.join("; ") || "No approved RPC transport available");
    },
  };
}
