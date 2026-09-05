import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFrozenFixture } from "../src/api/fixture-jobs.js";
import { getHistoricalFixtureByService } from "../src/api/historical-provider-receipts.js";
import {
  captureMarketplaceInvocationEvidence,
  loadMarketplaceInvocationProtocol,
  verifyMarketplaceInvocationEvidenceObject,
  verifyProtocolAgainstProject,
  writeMarketplaceInvocationEvidenceExclusive,
  type MarketplaceInvocationProtocol,
} from "../src/benchmark/marketplace-provenance.js";

const SERVICES = {
  "lending-rescue": "LENDING_RESCUE",
  "lp-rebalance": "LP_REBALANCE",
  "bounded-grid": "BOUNDED_GRID",
} as const;

function clocks(): { now: () => Date; monotonicNow: () => number } {
  let wall = Date.parse("2026-08-13T04:40:00.000Z");
  let monotonic = 0;
  return {
    now: () => {
      wall += 11;
      return new Date(wall);
    },
    monotonicNow: () => {
      monotonic += 7.4;
      return monotonic;
    },
  };
}

async function fixtureResponse(url: string): Promise<Response> {
  const slug = Object.keys(SERVICES).find((candidate) => url.includes(`/providers/${candidate}/`));
  if (!slug) return new Response("unknown provider", { status: 404 });
  const service = SERVICES[slug as keyof typeof SERVICES];
  const archived = getHistoricalFixtureByService(service);
  if (!archived) throw new Error(`Missing historical fixture capture for ${service}`);
  return Response.json(archived, { status: 200 });
}

describe("marketplace invocation provenance", () => {
  it("rejects corrected current output against the immutable historical protocol", async () => {
    const evidence = await captureMarketplaceInvocationEvidence({
      protocolCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...clocks(),
      fetch: async (input) => {
        const slug = Object.keys(SERVICES).find((candidate) => String(input).includes(`/providers/${candidate}/`));
        if (!slug) return new Response("unknown provider", { status: 404 });
        return Response.json(await runFrozenFixture(SERVICES[slug as keyof typeof SERVICES]));
      },
    });
    expect(evidence.aggregate.successCount).toBe(0);
    expect(evidence.records.every((record) => !record.success && record.error !== null)).toBe(true);
  });
  it("binds the protocol to the frozen tasks and committed candidate outputs", () => {
    const protocol = loadMarketplaceInvocationProtocol();
    expect(() => verifyProtocolAgainstProject(protocol)).not.toThrow();
    expect(protocol.tasks).toHaveLength(3);
    expect(protocol.execution.attemptPolicy).toBe("ONE_ATTEMPT_PER_RUN_NO_RETRY");
  });

  it("captures exactly two sequential public marketplace deliveries per task", async () => {
    const urls: string[] = [];
    const evidence = await captureMarketplaceInvocationEvidence({
      protocolCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...clocks(),
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        return fixtureResponse(url);
      },
    });

    expect(urls).toEqual([
      "https://positioncrew.dolepee.com/api/providers/lending-rescue/jobs",
      "https://positioncrew.dolepee.com/api/providers/lending-rescue/jobs",
      "https://positioncrew.dolepee.com/api/providers/lp-rebalance/jobs",
      "https://positioncrew.dolepee.com/api/providers/lp-rebalance/jobs",
      "https://positioncrew.dolepee.com/api/providers/bounded-grid/jobs",
      "https://positioncrew.dolepee.com/api/providers/bounded-grid/jobs",
    ]);
    expect(evidence.aggregate).toEqual({
      plannedAttemptCount: 6,
      recordedAttemptCount: 6,
      successCount: 6,
      allAttemptsSucceeded: true,
    });
    expect(evidence.records.map((record) => record.sequenceNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(evidence.records.every((record) => record.elapsedMilliseconds === 7)).toBe(true);
    expect(evidence.records.every((record) => record.observation?.jobHistory.length === 6)).toBe(true);
    expect(evidence.summaries.every((summary) => summary.outputHashesMatch)).toBe(true);
    expect(evidence.summaries.every((summary) => summary.evaluationHashesMatch)).toBe(true);
    expect(() =>
      verifyMarketplaceInvocationEvidenceObject(evidence, loadMarketplaceInvocationProtocol()),
    ).not.toThrow();
  });

  it("retains a failed planned call and continues without retrying it", async () => {
    let calls = 0;
    const evidence = await captureMarketplaceInvocationEvidence({
      protocolCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...clocks(),
      fetch: async (input) => {
        calls += 1;
        if (calls === 3) throw new Error("simulated transport failure");
        return fixtureResponse(String(input));
      },
    });

    expect(calls).toBe(6);
    expect(evidence.aggregate.successCount).toBe(5);
    expect(evidence.aggregate.allAttemptsSucceeded).toBe(false);
    expect(evidence.records[2]).toMatchObject({
      sequenceNumber: 3,
      benchmarkSlug: "lp-rebalance",
      runNumber: 1,
      httpStatus: 0,
      success: false,
      observation: null,
      error: "simulated transport failure",
    });
    expect(evidence.records[3]).toMatchObject({ benchmarkSlug: "lp-rebalance", runNumber: 2 });
    expect(() =>
      verifyMarketplaceInvocationEvidenceObject(evidence, loadMarketplaceInvocationProtocol()),
    ).not.toThrow();
  });

  it("rejects tampered evidence and changed protocol expectations", async () => {
    const protocol = loadMarketplaceInvocationProtocol();
    const evidence = await captureMarketplaceInvocationEvidence({
      protocolCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...clocks(),
      fetch: async (input) => fixtureResponse(String(input)),
    });
    const reordered = structuredClone(evidence);
    [reordered.records[0], reordered.records[1]] = [reordered.records[1]!, reordered.records[0]!];
    expect(() => verifyMarketplaceInvocationEvidenceObject(reordered, protocol)).toThrow();

    const changedProtocol = structuredClone(protocol) as MarketplaceInvocationProtocol;
    changedProtocol.tasks[0]!.expectedOutputHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    expect(() => verifyProtocolAgainstProject(changedProtocol)).toThrow(
      "output differs from the committed agent candidates",
    );
  });

  it("writes evidence once and refuses replacement", async () => {
    const evidence = await captureMarketplaceInvocationEvidence({
      protocolCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...clocks(),
      fetch: async (input) => fixtureResponse(String(input)),
    });
    const root = mkdtempSync(join(tmpdir(), "positioncrew-marketplace-provenance-"));
    const relative = "evidence/capture.json";
    const path = writeMarketplaceInvocationEvidenceExclusive(evidence, root, relative);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(evidence);
    expect(() => writeMarketplaceInvocationEvidenceExclusive(evidence, root, relative)).toThrow();
  });
});
