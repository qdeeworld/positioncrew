import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// @ts-ignore -- The operational ESM collector intentionally has no declaration output.
import { runShadowGridScheduledSession } from "../scripts/collect-bounded-grid-shadow-ledger.mjs";

const EPOCH = "2026-08-24T12:17:00.000Z";
const HORIZON = "2026-08-24T12:32:00.000Z";
const RUN_ID = "bg-20260824-12";
const HEAD_HASH = `sha256:${"ab".repeat(32)}`;
const BOUNDARY = [
  "Forward-only, zero-fund shadow outcomes use only actual block-pinned PancakeSwap WBNB/USDT observations recorded after precommitment.",
  "Conservative sampled crossings are simulations, not transactions, executable fills, realised PnL, strategy returns, or audited financial performance.",
  "The operator-scheduled record proves no external buyer, payment, revenue, demand, or Agent Advantage.",
];

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
  retryPolicy: {
    ambiguousFetchFailure: string;
    completedHttp5xxMaxRetriesPerTarget: number;
  };
  attempts: Array<{ outcome: string; response: unknown }>;
  claimBoundary: string[];
  collision: unknown;
  failure: string | null;
}

function environment(overrides: Record<string, string> = {}) {
  return {
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REPOSITORY: "qdeeworld/positioncrew",
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "1".repeat(40),
    GITHUB_WORKFLOW_REF:
      "qdeeworld/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
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

function collision() {
  return {
    schemaVersion: "positioncrew.bounded-grid-forward-shadow-collision.v1",
    accepted: false,
    state: "COLLISION_SKIPPED",
    windowId: RUN_ID,
    reason: "WINDOW_ALREADY_BOUND_TO_ANOTHER_AUTHENTICATED_RUN",
    incoming: {
      event: "schedule",
      repository: "qdeeworld/positioncrew",
      workflowPath: ".github/workflows/production-smoke.yml",
      runId: "123456789",
      runAttempt: "1",
      headSha: "1".repeat(40),
      workflowRef:
        "qdeeworld/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
      recordedAt: EPOCH,
    },
    originating: {
      event: "schedule",
      repository: "qdeeworld/positioncrew",
      workflowPath: ".github/workflows/production-smoke.yml",
      runId: "987654321",
      runAttempt: "1",
      headSha: "2".repeat(40),
      workflowRef:
        "qdeeworld/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
      recordedAt: EPOCH,
    },
    existing: {
      eventCount: 2,
      headHash: HEAD_HASH,
      publicUrl:
        "https://positioncrew.test/api/evidence/bounded-grid-forward-shadow/windows/bg-20260824-12",
    },
    recordedAt: EPOCH,
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
  it("gates collection on the successful exact-head production verifier job", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/production-smoke.yml", import.meta.url),
      "utf8",
    );
    const verifierStart = workflow.indexOf("  verify-production:");
    const shadowStart = workflow.indexOf("  bounded-grid-shadow-session:");
    const shadowEnd = workflow.indexOf("  attest-runtime-rotation-evidence:");
    expect(verifierStart).toBeGreaterThan(-1);
    expect(shadowStart).toBeGreaterThan(verifierStart);
    expect(shadowEnd).toBeGreaterThan(shadowStart);

    const verifierJob = workflow.slice(verifierStart, shadowStart);
    expect(verifierJob).toContain("run: npm run verify:production");
    expect(verifierJob).toContain("name: Enforce production verification");
    expect(verifierJob).toContain('run: test "$VERIFY_OUTCOME" = "success"');

    const shadowJob = workflow.slice(shadowStart, shadowEnd);
    const stepsStart = shadowJob.indexOf("    steps:");
    const collectorStart = shadowJob.indexOf(
      "node scripts/collect-bounded-grid-shadow-ledger.mjs",
    );
    const artifactStart = shadowJob.indexOf("      - name: Preserve session evidence");
    const shadowJobHeader = shadowJob.slice(0, stepsStart);
    expect(shadowJobHeader).toContain("needs: verify-production");
    expect(shadowJobHeader).toContain("needs.verify-production.result == 'success'");
    expect(shadowJobHeader).toContain("github.event_name == 'schedule'");
    expect(shadowJobHeader).toContain("github.event.schedule == '17 * * * *'");
    expect(shadowJobHeader).not.toContain("always()");
    expect(shadowJobHeader.indexOf("needs: verify-production")).toBeLessThan(
      shadowJobHeader.indexOf("needs.verify-production.result == 'success'"),
    );
    expect(artifactStart).toBeGreaterThan(collectorStart);
    expect(shadowJob.slice(artifactStart)).toContain("        if: always()");
  });

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

  it("retries one completed HTTP 5xx identically without shifting later targets", async () => {
    const runtime = harness([
      { body: tick("PRECOMMITTED", 2) },
      { body: { error: "temporary upstream failure" }, status: 503 },
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
      "HTTP_ERROR",
      "ACCEPTED",
      "ACCEPTED",
      "ACCEPTED",
    ]);
    expect(result.retryPolicy).toMatchObject({
      ambiguousFetchFailure: "FAIL_CLOSED_NO_RETRY",
      completedHttp5xxMaxRetriesPerTarget: 1,
    });
  });

  it.each([
    ["timeout", "AbortError", "request timed out"],
    ["socket reset", "Error", "socket reset by peer"],
  ])("does not retry an ambiguous %s", async (_label, errorName, errorMessage) => {
    const failure = new Error(errorMessage);
    failure.name = errorName;
    const runtime = harness([{ error: failure }]);

    await expect(
      runShadowGridScheduledSession({ environment: environment(), ...runtime }),
    ).rejects.toThrow(/ambiguous fetch failure and was not retried/u);
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.artifacts.at(-1)).toMatchObject({
      status: "FAILED",
      retryPolicy: {
        ambiguousFetchFailure: "FAIL_CLOSED_NO_RETRY",
        completedHttp5xxMaxRetriesPerTarget: 1,
      },
      attempts: [{ outcome: "AMBIGUOUS_FETCH_FAILURE" }],
    });
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

  it("turns an authenticated opening collision into a successful zero-follow-up skip artifact", async () => {
    const response = collision();
    response.recordedAt = "2026-08-24T12:17:01.000Z";
    const runtime = harness([{ body: response, status: 409 }]);
    const result = await runShadowGridScheduledSession({ environment: environment(), ...runtime });

    expect(runtime.calls).toHaveLength(1);
    expect(runtime.sleeps).toEqual([]);
    expect(result).toMatchObject({
      schemaVersion: "positioncrew.bounded-grid-forward-shadow-scheduled-session.v2",
      status: "SKIPPED",
      finalStatus: "COLLISION_SKIPPED",
      runId: RUN_ID,
      collision: {
        reason: "WINDOW_ALREADY_BOUND_TO_ANOTHER_AUTHENTICATED_RUN",
        originating: { runId: "987654321" },
      },
      attempts: [{ outcome: "COLLISION_SKIPPED", httpStatus: 409 }],
    });
    expect(result.claimBoundary).toEqual(BOUNDARY);
  });

  it.each([
    ["generic conflict", () => ({ error: "conflict" })],
    ["invalid head hash", (response: ReturnType<typeof collision>) => {
      response.existing.headHash = "not-a-hash";
      return response;
    }],
    ["self-consistent wrong hour", (response: ReturnType<typeof collision>) => {
      const shifted = "2026-08-24T13:17:00.000Z";
      response.windowId = "bg-20260824-13";
      response.recordedAt = shifted;
      response.incoming.recordedAt = shifted;
      response.originating.recordedAt = shifted;
      response.existing.publicUrl =
        "https://positioncrew.test/api/evidence/bounded-grid-forward-shadow/windows/bg-20260824-13";
      return response;
    }],
    ["incoming time mismatch", (response: ReturnType<typeof collision>) => {
      response.incoming.recordedAt = "2026-08-24T12:18:00.000Z";
      return response;
    }],
    ["originating time after collision", (response: ReturnType<typeof collision>) => {
      response.originating.recordedAt = "2026-08-24T12:18:00.000Z";
      return response;
    }],
    ["changed claim boundary", (response: ReturnType<typeof collision>) => {
      response.claimBoundary = ["Unverified boundary."];
      return response;
    }],
  ])("fails closed on a malformed opening collision: %s", async (_label, mutate) => {
    const runtime = harness([{ body: mutate(collision()), status: 409 }]);

    await expect(
      runShadowGridScheduledSession({ environment: environment(), ...runtime }),
    ).rejects.toThrow(/collision returned an invalid response/u);
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.sleeps).toEqual([]);
    expect(runtime.artifacts.at(-1)).toMatchObject({
      status: "FAILED",
      attempts: [{ outcome: "INVALID_RESPONSE", httpStatus: 409 }],
    });
  });

  it("rejects a collision response after the opening tick", async () => {
    const runtime = harness([
      { body: tick("PRECOMMITTED") },
      { body: collision(), status: 409 },
    ]);

    await expect(
      runShadowGridScheduledSession({ environment: environment(), ...runtime }),
    ).rejects.toThrow(/only for an unpinned opening request/u);
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.artifacts.at(-1)).toMatchObject({
      status: "FAILED",
      attempts: [
        { outcome: "ACCEPTED" },
        { outcome: "INVALID_RESPONSE", httpStatus: 409 },
      ],
    });
  });

  it("fails closed when a completed opening 5xx is followed by a collision", async () => {
    const runtime = harness([
      { body: { error: "concurrent initialization" }, status: 503 },
      { body: collision(), status: 409 },
    ]);

    await expect(
      runShadowGridScheduledSession({
        environment: environment(),
        retryDelayMilliseconds: 1_000,
        ...runtime,
      }),
    ).rejects.toThrow(/only on the first opening attempt/u);
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.artifacts.at(-1)).toMatchObject({
      status: "FAILED",
      finalStatus: null,
      attempts: [
        { outcome: "HTTP_ERROR", httpStatus: 503 },
        { outcome: "INVALID_RESPONSE", httpStatus: 409 },
      ],
    });
  });

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
        "qdeeworld/positioncrew/.github/workflows/bounded-grid-shadow-ledger.yml@refs/heads/main",
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
    const timeout = new Error("request timed out after reaching the server");
    timeout.name = "AbortError";
    const runtime = harness([
      { body: tick("PRECOMMITTED") },
      { error: timeout },
    ]);
    await expect(
      runShadowGridScheduledSession({
        environment: environment(),
        retryDelayMilliseconds: 1_000,
        ...runtime,
      }),
    ).rejects.toThrow(/ambiguous fetch failure and was not retried/u);

    const finalArtifact = runtime.artifacts.at(-1)!;
    expect(runtime.calls).toHaveLength(2);
    expect(
      runtime.calls.filter((call) => call.requestedAt === "2026-08-24T12:22:00.000Z"),
    ).toHaveLength(1);
    expect(finalArtifact.status).toBe("FAILED");
    expect(finalArtifact.attempts.map((attempt) => attempt.outcome)).toEqual([
      "ACCEPTED",
      "AMBIGUOUS_FETCH_FAILURE",
    ]);
    expect(finalArtifact.attempts[0]!.response).toMatchObject({
      headHash: HEAD_HASH,
      eventCount: 2,
    });
    expect(finalArtifact.failure).toMatch(/ambiguous fetch failure and was not retried/u);
  });
});
