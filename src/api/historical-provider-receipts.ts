import archive from "../../evidence/historical-provider-receipts.2026-09-05.json" with { type: "json" };
import type { PositionCrewRequest } from "../contracts/index.js";
import { FixtureJobResponseSchema } from "./fixture-response-schema.js";
type HistoricalFixtureResponse = ReturnType<typeof FixtureJobResponseSchema.parse>;

/** Archived v1 evidence only. Never use this lookup to assess current provider health or financial correctness. */
export function getHistoricalFixtureReceipt(evaluationHash: string): HistoricalFixtureResponse | null {
  const entry = archive.fixtures.find((item) => item.response.result.evaluation.evaluationHash.toLowerCase() === evaluationHash.toLowerCase());
  return entry ? FixtureJobResponseSchema.parse(structuredClone(entry.response)) : null;
}

/** Historical capture replay for provenance tests, not a current provider execution. */
export function getHistoricalFixtureByService(service: PositionCrewRequest["service"]): HistoricalFixtureResponse | null {
  const entry = archive.fixtures.find((item) => item.service === service);
  return entry ? getHistoricalFixtureReceipt(entry.response.result.evaluation.evaluationHash) : null;
}
