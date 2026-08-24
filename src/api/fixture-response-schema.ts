import { z } from "zod";
import { JobRecordSchema } from "../commerce/job-record-schema.js";
import { PositionCrewDeliverableSchema, PositionCrewRequestSchema } from "../contracts/index.js";
import { HashSchema, TimestampSchema } from "../contracts/common.js";
import { EvaluationReceiptSchema } from "../commerce/types.js";

const BenchmarkLockSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.benchmark-lock.v1"),
    taskId: z.string().min(8),
    fixtureHash: HashSchema,
    rubricHash: HashSchema,
    protocolHash: HashSchema,
  })
  .strict();

export const FixtureJobResponseSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.fixture-job-response.v1"),
    evidenceMode: z.enum([
      "FROZEN_BSC_TEST_FIXTURE",
      "CALLER_SUPPLIED_OBSERVATIONS",
      "CURRENT_BLOCK_PINNED",
    ]),
    commerceMode: z.literal("IN_MEMORY_CONFORMANCE"),
    advantageStatus: z.literal("PENDING_INDEPENDENT_BLIND_EVALUATION"),
    generatedAt: TimestampSchema,
    claimBoundary: z.array(z.string().min(10)).min(3),
    benchmarkLock: BenchmarkLockSchema.nullable(),
    receipt: z
      .object({
        mode: z.enum(["PUBLIC_REPRODUCIBLE", "SESSION_EMBEDDED"]),
        path: z.string().nullable(),
        evaluationHash: HashSchema,
      })
      .strict(),
    result: z
      .object({
        job: JobRecordSchema,
        request: PositionCrewRequestSchema,
        deliverable: PositionCrewDeliverableSchema,
        evaluation: EvaluationReceiptSchema,
      })
      .strict(),
  })
  .strict();
