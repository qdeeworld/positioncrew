import type { CommerceAdapter, EvaluationReceipt, JobRecord } from "../commerce/types.js";
import {
  PositionCrewDeliverableSchema,
  PositionCrewRequestSchema,
  type PositionCrewDeliverable,
  type PositionCrewRequest,
} from "../contracts/index.js";
import { canonicalHash } from "../core/canonical.js";
import { jsonDataUri } from "../core/data-uri.js";
import { evaluateProviderConformance } from "../evaluators/provider-conformance.js";
import { executeProvider, PROVIDER_IDS } from "../providers/index.js";

const TEST_SETTLEMENT_TOKEN = {
  symbol: "TEST_USDC",
  address: "0x0000000000000000000000000000000000001001",
  decimals: 6,
} as const;

export interface ProviderJobResult {
  job: JobRecord;
  request: PositionCrewRequest;
  deliverable: PositionCrewDeliverable;
  evaluation: ReturnType<typeof evaluateProviderConformance>;
}

export type ProviderJobEvaluator = (
  request: PositionCrewRequest,
  deliverable: PositionCrewDeliverable,
  evaluatorId: string,
  now: Date,
  requestHashOverride?: string,
) => EvaluationReceipt;

export interface RunProviderJobOptions {
  persistExpiredRefusal?: boolean;
  requestHash?: string;
  providerId?: string;
  evaluatorId?: string;
  deliverable?: PositionCrewDeliverable;
  evaluate?: ProviderJobEvaluator;
}

export async function runProviderJob(
  adapter: CommerceAdapter,
  requestInput: PositionCrewRequest,
  now: Date,
  options: RunProviderJobOptions = {},
): Promise<ProviderJobResult> {
  const request = PositionCrewRequestSchema.parse(requestInput);
  const requestHash = options.requestHash ?? canonicalHash(request);
  const providerId = options.providerId ?? PROVIDER_IDS[request.service];
  const evaluatorId = options.evaluatorId ?? `positioncrew:evaluator:${request.service.toLowerCase()}:v1`;
  const persistExpiredRefusal =
    options.persistExpiredRefusal === true && now.getTime() >= Date.parse(request.deadline);
  const commerceDeadline = persistExpiredRefusal
    ? new Date(now.getTime() + 1).toISOString()
    : request.deadline;
  let job = await adapter.createJob({
    schemaVersion: "positioncrew.job-envelope.v1",
    idempotencyKey: `${request.service.toLowerCase()}:${request.requestId}`,
    service: request.service,
    requestId: request.requestId,
    requestHash,
    budget: {
      chainId: request.chainId,
      token: TEST_SETTLEMENT_TOKEN,
      amount: "5",
    },
    createdAt: now.toISOString(),
    deadline: commerceDeadline,
  });
  job = await adapter.fund(job.jobId, {
    tokenAddress: TEST_SETTLEMENT_TOKEN.address,
    amount: "5",
    transactionReference: `memory-funding:${job.jobId}`,
    fundedAt: now.toISOString(),
  });
  job = await adapter.assignProvider(job.jobId, providerId);
  job = await adapter.assignEvaluator(job.jobId, evaluatorId);

  const deliverable = PositionCrewDeliverableSchema.parse(
    options.deliverable ?? executeProvider(request, now),
  );
  if (persistExpiredRefusal && deliverable.status !== "REFUSED_EXPIRED") {
    throw new Error("An expired request may persist only an explicit expired refusal");
  }
  const deliverableHash = canonicalHash(deliverable);
  job = await adapter.submitDeliverable(job.jobId, {
    schemaVersion: "positioncrew.deliverable-manifest.v1",
    requestHash,
    deliverableHash,
    mediaType: "application/json",
    uri: jsonDataUri(deliverable),
    createdAt: now.toISOString(),
  });
  const evaluation = (options.evaluate ?? evaluateProviderConformance)(
    request,
    deliverable,
    evaluatorId,
    now,
    requestHash,
  );
  job = await adapter.evaluate(job.jobId, evaluation);
  return { job, request, deliverable, evaluation };
}
