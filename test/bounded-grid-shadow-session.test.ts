import { describe, expect, it } from "vitest";

// @ts-ignore -- The operational ESM collector intentionally has no declaration output.
import { runShadowGridScheduledSession } from "../scripts/collect-bounded-grid-shadow-ledger.mjs";

const EPOCH = "2026-08-24T12:17:00.000Z";
const HORIZON = "2026-08-24T12:32:00.000Z";
const RUN_ID = "bg-20260824-12";
const HEAD_HASH = `sha256:${"ab".repeat(32)}`;
const BOUNDARY = ["Forward-only actual observations.", "Zero-fund simulations are not transactions."];

interface QueueItem {
  body?: unknown;
  status?: number;
  duration?: number;
  error?: Error;
}

interface CapturedCall {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
  requestedAt: string;
}

interface SessionArtifact {
  status: string;
  finalStatus: string | null;
  runId: string | null;
  targets: Array<{ targetAt: string | null }>;
  attempts: Array<{ outcome: string; response: unknown }>;
  claimBoundary: string[];
  failure: string | null;
}

function environment(overrides: Record<string, string> = {}) {
  return {
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REPOSITORY: "dolepee/positioncrew",
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "1".repeat(40),
    GITHUB_WORKFLOW_REF:
      "dolepee/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
    SHADOW_GRID_TICK_TOKEN: "test-token",
    POSITIONCREW_BASE_URL: "https://positioncrew.test",
    ...overrides,
  };
}

function tick(state: string, eventCount = 2) {
  const late = state === "LATE_START_SKIPPED";
  return {
    schemaVersion: "positioncrew.bounded-grid-forward-shadow-tick.v1",
    accepted: true,
    recordedAt: EPOCH,
    runId: RUN_ID,
    state,
    headHash: late ? null : HEAD_HASH,
    eventCount: late ? 0 : eventCount,
    epochStartedAt: late ? null : EPOCH,
    horizonEndsAt: late ? null : HORIZON,
    claimBoundary: BOUNDARY,
  };
}

function harness(
  queue: QueueItem[],
  sleepOverride?: (clock: number, delay: number) => number,
) {
  let clock = Date.parse(EPOCH);
  const calls: CapturedCall[] = [];
  const sleeps: number[] = [];
  const artifacts: SessionArtifact[] = [];
  return {
    calls,
    sleeps,
    artifacts,
    now: () => clock,
    sleep: async (delay: number) => {
      sleeps.push(delay);
      clock = sleepOverride ? sleepOverride(clock, delay) : clock + delay;
    },
    fetchImpl: async (
      url: string | URL,
      init: RequestInit & { headers: Record<string, string> },
    ) => {
      const next = queue.shift();
      calls.push({ url: String(url), init, requestedAt: new Date(clock).toISOString() });
      if (!next) throw new Error("Unexpected collector request");
      clock += next.duration ?? 0;
      if (next.error) throw next.error;
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    persistArtifact: async (artifact: SessionArtifact) => {
      artifacts.push(structuredClone(artifact));
    },
  };
}

describe("bounded-grid scheduled session collector", () => {
  it("opens once and uses absolute +5/+10/+15 targets without drift", async () => {
    const runtime = harness([
      { body: tick("PRECOMMITTED", 2), duration: 20_000 },
      { body: tick("PRECOMMITTED", 3), duration: 40_000 },
      { body: tick("PRECOMMITTED", 4), duration: 30_000 },
      { body: tick("CLOSED", 5), duration: 10_000 },
    ]);
    const result = await runShadowGridScheduledSession({
      environment: environment(),
      ...runtime,
    });

    expect(runtime.calls.map((call) => call.requestedAt)).toEqual([
      "2026-08-24T12:17:00.000Z",
      "2026-08-24T12:22:00.000Z",
      "2026-08-24T12:27:00.000Z",
      "2026-08-24T12:32:00.000Z",
    ]);
    for (const call of runtime.calls) {
      expect(call.url).toBe("https://positioncrew.test/api/internal/bounded-grid-forward-shadow/tick");
      expect(call.init.method).toBe("POST");
      expect(call.init).not.toHaveProperty("body");
      expect(call.init.headers["X-GitHub-Run-Id"]).toBe("123456789");
    }
    expect(runtime.calls[0]!.init.headers).not.toHaveProperty(
      "X-PositionCrew-Shadow-Run-Id",
    );
    for (const call of runtime.calls.slice(1)) {
      expect(call.init.headers["X-PositionCrew-Shadow-Run-Id"]).toBe(RUN_ID);
    }
    expect(result).toMatchObject({ status: "COMPLETED", finalStatus: "CLOSED" });
    expect(result.targets.map((target: { targetAt: string | null }) => target.targetAt)).toEqual([
      EPOCH,
      "2026-08-24T12:22:00.000Z",
      "2026-08-24T12:27:00.000Z",
      HORIZON,
    ]);
    expect(result.claimBoundary).toEqual(BOUNDARY);
  });

  it("retries one network failure identically without shifting later targets", async () => {
    const runtime = harness([
      { body: tick("PRECOMMITTED", 2) },
      { error: new Error("temporary outage") },
      { body: tick("PRECOMMITTED", 3) },
      { body: tick("PRECOMMITTED", 4) },
      { body: tick("CLOSED", 5) },
    ]);
    const result = await runShadowGridScheduledSession({
      environment: environment(),
      retryDelayMilliseconds: 1_000,
      ...runtime,
    });

    expect(runtime.calls).toHaveLength(5);
    expect(runtime.calls[1]!.url).toBe(runtime.calls[2]!.url);
    expect(runtime.calls[1]!.init.headers).toEqual(runtime.calls[2]!.init.headers);
    expect(runtime.calls[0]!.init.headers).not.toHaveProperty(
      "X-PositionCrew-Shadow-Run-Id",
    );
    expect(runtime.calls[1]!.init.headers["X-PositionCrew-Shadow-Run-Id"]).toBe(RUN_ID);
    expect(runtime.calls[2]!.init.headers["X-PositionCrew-Shadow-Run-Id"]).toBe(RUN_ID);
    expect(runtime.calls[3]!.requestedAt).toBe("2026-08-24T12:27:00.000Z");
    expect(runtime.calls[4]!.requestedAt).toBe(HORIZON);
    expect(result.attempts.map((attempt: { outcome: string }) => attempt.outcome)).toEqual([
      "ACCEPTED",
      "NETWORK_ERROR",
      "ACCEPTED",
      "ACCEPTED",
      "ACCEPTED",
    ]);
  });

  it.each(["LATE_START_SKIPPED", "REFUSED", "VOID_SOURCE_GAP", "RISK_EXIT", "CLOSED"])(
    "stops immediately on opening state %s",
    async (state) => {
      const runtime = harness([{ body: tick(state) }]);
      const result = await runShadowGridScheduledSession({ environment: environment(), ...runtime });
      expect(runtime.calls).toHaveLength(1);
      expect(runtime.sleeps).toEqual([]);
      expect(result.finalStatus).toBe(state);
    },
  );

  it("does not post after crossing the initial run hour", async () => {
    const runtime = harness(
      [{ body: tick("PRECOMMITTED") }],
      () => Date.parse("2026-08-24T13:00:00.000Z"),
    );
    await expect(
      runShadowGridScheduledSession({ environment: environment(), ...runtime }),
    ).rejects.toThrow(/crossed its initial UTC-hour/u);
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.artifacts.at(-1)).toMatchObject({ status: "FAILED", runId: RUN_ID });
  });

  it.each([
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REPOSITORY: "attacker/fork" },
    { GITHUB_RUN_ATTEMPT: "2" },
    {
      GITHUB_WORKFLOW_REF:
        "dolepee/positioncrew/.github/workflows/bounded-grid-shadow-ledger.yml@refs/heads/main",
    },
  ])("rejects bad identity before network access", async (override) => {
    const runtime = harness([]);
    await expect(
      runShadowGridScheduledSession({ environment: environment(override), ...runtime }),
    ).rejects.toThrow();
    expect(runtime.calls).toHaveLength(0);
    expect(runtime.artifacts.at(-1)?.status).toBe("FAILED");
  });

  it("preserves accepted and failed attempts in a partial-failure artifact", async () => {
    const runtime = harness([
      { body: tick("PRECOMMITTED") },
      { error: new Error("first outage") },
      { error: new Error("second outage") },
    ]);
    await expect(
      runShadowGridScheduledSession({
        environment: environment(),
        retryDelayMilliseconds: 1_000,
        ...runtime,
      }),
    ).rejects.toThrow(/after one retry/u);

    const finalArtifact = runtime.artifacts.at(-1)!;
    expect(finalArtifact.status).toBe("FAILED");
    expect(finalArtifact.attempts.map((attempt) => attempt.outcome)).toEqual([
      "ACCEPTED",
      "NETWORK_ERROR",
      "NETWORK_ERROR",
    ]);
    expect(finalArtifact.attempts[0]!.response).toMatchObject({
      headHash: HEAD_HASH,
      eventCount: 2,
    });
    expect(finalArtifact.failure).toMatch(/after one retry/u);
  });
});
