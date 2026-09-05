import { describe, expect, it } from "vitest";
import archive from "../evidence/historical-provider-receipts.2026-09-05.json" with { type: "json" };
import { getHistoricalFixtureByService, getHistoricalFixtureReceipt } from "../src/api/historical-provider-receipts.js";
import { runFrozenFixture } from "../src/api/fixture-jobs.js";
import { canonicalHash } from "../src/core/canonical.js";
import { buildErc8183TestnetDeliverable } from "../src/commerce/erc8183-evidence.js";

describe("immutable historical provider receipt lookup", () => {
  it("preserves all four captured request, output, evaluation, and response commitments", () => {
    expect(archive.fixtures).toHaveLength(4);
    for (const entry of archive.fixtures) {
      const response = getHistoricalFixtureReceipt(entry.response.result.evaluation.evaluationHash)!;
      expect(response).not.toBeNull();
      expect(canonicalHash(response)).toBe(canonicalHash(entry.response));
      const { evaluationHash, ...evaluationBody } = response.result.evaluation;
      expect(canonicalHash(evaluationBody)).toBe(evaluationHash);
      expect(canonicalHash(response.result.request)).toBe(response.result.evaluation.requestHash);
      expect(canonicalHash(response.result.deliverable)).toBe(response.result.evaluation.deliverableHash);
    }
  });

  it("returns detached archived values and leaves current LP evaluation independent", async () => {
    const archived = getHistoricalFixtureByService("LP_REBALANCE")!;
    const hash = archived.result.evaluation.evaluationHash;
    expect(archived.result.deliverable.status).toBe("ACTIONABLE");
    archived.result.deliverable.summary = "Caller mutation";
    expect(getHistoricalFixtureReceipt(hash)!.result.deliverable.summary).not.toBe("Caller mutation");
    const current = await runFrozenFixture("LP_REBALANCE");
    expect(current.result.deliverable).toMatchObject({ status: "NO_ACTION", decision: "HOLD" });
    expect(current.result.evaluation.evaluationHash).not.toBe(hash);
    expect(getHistoricalFixtureReceipt(current.result.evaluation.evaluationHash)).toBeNull();
  });

  it("keeps funded manifest content stable after caller mutation", async () => {
    const manifest = (await buildErc8183TestnetDeliverable(490))!;
    const original = canonicalHash(manifest);
    manifest.response.content = "Caller mutation";
    expect(canonicalHash(await buildErc8183TestnetDeliverable(490))).toBe(original);
  });
});
