import { describe, expect, it } from "vitest";
import { currentHireExpired } from "../web/src/recent-job-expiry.js";
import type { FreshMarketplaceChain } from "../web/src/types.js";

const start = Date.parse("2026-09-07T12:00:00.000Z");
function savedJob() {
  // Only the expiry projection is under test here, not server authentication.
  return {
    job: { state: "CREATED" },
    hire: {
      evidenceMode: "CURRENT_BLOCK_PINNED",
      request: { deadline: new Date(start + 300_000).toISOString(), maxDataAgeSeconds: 300 },
      evidence: {
        evidenceClass: "CURRENT_BLOCK_PINNED",
        source: { observedAt: new Date(start).toISOString() },
        observationBinding: { expiresAt: new Date(start + 240_000).toISOString() },
      },
    },
  } as unknown as FreshMarketplaceChain;
}

describe("saved current-job expiry", () => {
  it("allows a still-current job and blocks at the authenticated boundary", () => {
    expect(currentHireExpired(savedJob(), start + 239_999)).toBe(false);
    expect(currentHireExpired(savedJob(), start + 240_000)).toBe(true);
  });
  it("uses the earlier request deadline", () => {
    const chain = savedJob();
    chain.hire.request.deadline = new Date(start + 10_000).toISOString();
    expect(currentHireExpired(chain, start + 10_000)).toBe(true);
  });
  it("uses the earlier maximum observation age", () => {
    const chain = savedJob();
    chain.hire.request.maxDataAgeSeconds = 5;
    expect(currentHireExpired(chain, start + 4_999)).toBe(false);
    expect(currentHireExpired(chain, start + 5_000)).toBe(true);
  });
  it.each(["RUNNING", "COMPLETED", "FAILED"] as const)("does not hide %s recovery or history", (state) => {
    const chain = savedJob();
    chain.job.state = state;
    expect(currentHireExpired(chain, start + 900_000)).toBe(false);
  });
  it("does not expire historical replay or an unavailable chain", () => {
    const chain = savedJob();
    chain.hire.evidenceMode = "HISTORICAL_FIXTURE";
    expect(currentHireExpired(chain, start + 900_000)).toBe(false);
    expect(currentHireExpired(null, start)).toBe(false);
  });
  it.each([undefined, "bad date", 123])("blocks an unusable deadline %s", (deadline) => {
    const chain = savedJob();
    chain.hire.request.deadline = deadline;
    expect(currentHireExpired(chain, start)).toBe(true);
  });
  it.each([0, -1, NaN, Infinity, "300"])("blocks an unusable freshness limit %s", (age) => {
    const chain = savedJob();
    chain.hire.request.maxDataAgeSeconds = age;
    expect(currentHireExpired(chain, start)).toBe(true);
  });
  it("does not rewrite the saved request or evidence", () => {
    const chain = savedJob();
    const original = JSON.stringify(chain);
    currentHireExpired(chain, start + 900_000);
    expect(JSON.stringify(chain)).toBe(original);
  });
});
