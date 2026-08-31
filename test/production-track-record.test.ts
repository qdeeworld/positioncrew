import { describe, expect, it } from "vitest";
import epoch from "../evidence/production-monitor-epoch.json" with { type: "json" };
import snapshot from "../evidence/production-track-record.json" with { type: "json" };
import {
  appendProductionTrackRecordRun,
  parseProductionTrackRecordSnapshot,
  unavailableProductionTrackRecord,
  type ProductionMonitorEpoch,
  type ProductionTrackRecordRun,
} from "../src/operations/production-track-record.js";

const monitorEpoch = epoch as ProductionMonitorEpoch;

function run(
  runId: number,
  createdAt: string,
  conclusion: string | null,
  status = "completed",
): ProductionTrackRecordRun {
  return {
    runId,
    status,
    conclusion,
    createdAt,
    completedAt: status === "completed" ? createdAt : null,
    headSha: String(runId).padStart(40, "0"),
    url: `https://github.com/qdeeworld/positioncrew/actions/runs/${runId}`,
  };
}

describe("production track record", () => {
  it("appends every scheduled outcome after the fixed epoch and retains failures", () => {
    const first = appendProductionTrackRecordRun(
      snapshot,
      monitorEpoch,
      run(2, "2026-08-13T04:00:00.000Z", "success"),
      "2026-08-13T04:05:00.000Z",
    );
    const pending = appendProductionTrackRecordRun(
      first,
      monitorEpoch,
      run(3, "2026-08-13T04:30:00.000Z", null, "in_progress"),
      "2026-08-13T04:31:00.000Z",
    );
    const record = appendProductionTrackRecordRun(
      pending,
      monitorEpoch,
      run(4, "2026-08-13T05:00:00.000Z", "failure"),
      "2026-08-13T05:05:00.000Z",
    );

    expect(record.status).toBe("DEGRADED");
    expect(record.runs.map((candidate) => candidate.runId)).toEqual([4, 3, 2]);
    expect(record.summary).toMatchObject({
      totalScheduledRunsSinceEpoch: 3,
      observedRunCount: 3,
      completedRuns: 2,
      successfulRuns: 1,
      unsuccessfulRuns: 1,
      pendingRuns: 1,
      rollingPassRatePct: 50,
      rollingWindowStartedAt: "2026-08-13T04:00:00.000Z",
      rollingWindowEndedAt: "2026-08-13T05:00:00.000Z",
    });
  });

  it("recomputes the public summary instead of trusting snapshot claims", () => {
    const tampered = structuredClone(snapshot) as Record<string, unknown>;
    tampered.status = "OPERATIONAL";
    tampered.summary = {
      ...(tampered.summary as Record<string, unknown>),
      successfulRuns: 999,
      rollingPassRatePct: 100,
    };
    const record = parseProductionTrackRecordSnapshot(tampered, monitorEpoch);
    expect(record.status).toBe("COLLECTING");
    expect(record.summary.successfulRuns).toBe(0);
    expect(record.summary.rollingPassRatePct).toBeNull();
    expect(record.source.provider).toBe("GITHUB_ACTIONS_SNAPSHOT");
  });

  it("deduplicates a rerun without inflating the lifetime count", () => {
    const first = appendProductionTrackRecordRun(
      snapshot,
      monitorEpoch,
      run(9, "2026-08-13T04:10:00.000Z", "failure"),
    );
    const rerun = appendProductionTrackRecordRun(
      first,
      monitorEpoch,
      run(9, "2026-08-13T04:10:00.000Z", "success"),
    );
    expect(rerun.summary.totalScheduledRunsSinceEpoch).toBe(1);
    expect(rerun.summary.successfulRuns).toBe(1);
    expect(rerun.summary.unsuccessfulRuns).toBe(0);
  });

  it("rejects an invalid epoch and exposes a bounded unavailable record", () => {
    const invalid = structuredClone(snapshot) as Record<string, unknown>;
    invalid.epoch = { schemaVersion: monitorEpoch.schemaVersion, startedAt: "2026-08-14T00:00:00.000Z" };
    expect(() => parseProductionTrackRecordSnapshot(invalid, monitorEpoch)).toThrow(
      "does not match the committed epoch",
    );
    const record = unavailableProductionTrackRecord(monitorEpoch);
    expect(record.status).toBe("SOURCE_UNAVAILABLE");
    expect(record.source.sourceStatus).toBe("UNAVAILABLE");
    expect(record.summary.totalScheduledRunsSinceEpoch).toBeNull();
  });
});
