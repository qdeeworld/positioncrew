import { describe, expect, it } from "vitest";
import { evaluateLendingRescue } from "../src/evaluators/lending-rescue.js";
import { evaluateProviderConformance } from "../src/evaluators/provider-conformance.js";
import { createLendingRescueDeliverable } from "../src/providers/lending-rescue.js";
import { FIXTURE_NOW, lendingFixture } from "./helpers.js";

const evaluatorId = "positioncrew:evaluator:lending-rescue:v1";

function actionable() {
  const request = lendingFixture();
  const output = createLendingRescueDeliverable(request, new Date(request.requestedAt));
  expect(output.status).toBe("ACTIONABLE");
  expect(output.recommendation).not.toBeNull();
  expect(output.alternatives.length).toBeGreaterThan(0);
  expect(Date.parse(output.generatedAt)).toBeLessThan(FIXTURE_NOW.getTime());
  expect(Date.parse(output.expiresAt)).toBeGreaterThan(FIXTURE_NOW.getTime());
  return { request, output };
}

describe("Lending action expiry at actual evaluation time", () => {
  it("accepts an unexpired native recommendation and its alternatives", () => {
    const { request, output } = actionable();
    const receipt = evaluateLendingRescue(request, output, evaluatorId, FIXTURE_NOW);
    expect(receipt.passed).toBe(true);
    expect(receipt.score).toBe(100);
    expect(receipt.checks.find((entry) => entry.id === "lending-action-window")?.passed).toBe(true);
  });

  for (const field of ["recommendation", "alternative"] as const) {
    it.each([-1, 0])(`rejects the ${field} at deadline offset %i ms even though the receipt is still usable`, (offset) => {
      const { request, output } = actionable();
      const action = field === "recommendation" ? output.recommendation! : output.alternatives[0]!;
      action.executeBefore = new Date(FIXTURE_NOW.getTime() + offset).toISOString();
      expect(Date.parse(action.executeBefore)).toBeGreaterThan(Date.parse(output.generatedAt));
      const receipt = evaluateLendingRescue(request, output, evaluatorId, FIXTURE_NOW);
      expect(receipt.passed).toBe(false);
      expect(receipt.score).toBeLessThan(100);
      expect(receipt.checks.find((entry) => entry.id === "lending-action-window")?.passed).toBe(false);
      expect(receipt.checks.find((entry) => entry.id === "financial-invariants")?.passed).toBe(false);
      expect(receipt.checks.find((entry) => entry.id === "bounded-expiry")?.passed).toBe(true);
    });
  }

  it("re-evaluates the same payload against the supplied evaluation clock", () => {
    const { request, output } = actionable();
    const deadline = new Date(FIXTURE_NOW.getTime() + 1);
    output.recommendation!.executeBefore = deadline.toISOString();
    const before = evaluateProviderConformance(request, output, evaluatorId, FIXTURE_NOW);
    const atDeadline = evaluateProviderConformance(request, output, evaluatorId, deadline);
    expect(before.passed).toBe(true);
    expect(before.score).toBe(100);
    expect(atDeadline.passed).toBe(false);
    expect(atDeadline.score).toBeLessThan(100);
    expect(before.deliverableHash).toBe(atDeadline.deliverableHash);
    expect(before.evaluationHash).not.toBe(atDeadline.evaluationHash);
  });

  it("does not invalidate a legitimate receipted expiry refusal with no action", () => {
    const request = lendingFixture();
    const now = new Date(Date.parse(request.deadline) + 1);
    const output = createLendingRescueDeliverable(request, now);
    expect(output.status).toBe("REFUSED_EXPIRED");
    const receipt = evaluateProviderConformance(request, output, evaluatorId, now);
    expect(receipt.passed).toBe(true);
    expect(receipt.score).toBe(100);
  });
});
