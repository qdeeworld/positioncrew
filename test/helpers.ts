import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LendingRescueRequestSchema,
  type LendingRescueRequest,
} from "../src/contracts/lending-rescue.js";
import {
  YieldOptimizationRequestSchema,
  type YieldOptimizationRequest,
} from "../src/contracts/yield-optimization.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/lending-rescue/stressed-venus-position.v1.json", import.meta.url),
);

export function lendingFixture(): LendingRescueRequest {
  return LendingRescueRequestSchema.parse(
    JSON.parse(readFileSync(fixturePath, "utf8")),
  );
}

/** A fresh synthetic policy for positive migration tests, never a legacy request upgrade. */
export function freshYieldFixture(): YieldOptimizationRequest {
  const original = YieldOptimizationRequestSchema.parse(JSON.parse(readFileSync(
    new URL("../fixtures/yield-optimization/venus-to-beefy.v1.json", import.meta.url), "utf8",
  )));
  return YieldOptimizationRequestSchema.parse({
    ...original,
    requestId: `${original.requestId}-explicit-budget-test`,
    maxActionUsd: original.capitalUsd,
    maxAllocationUsd: original.capitalUsd,
    maxExecutionCostUsd: original.maxActionUsd,
  });
}

export const FIXTURE_NOW = new Date("2026-08-12T16:00:30.000Z");
