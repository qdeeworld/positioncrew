import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  brainOnBnbPaymentContract,
  HealthFactorLiveMatchJobSchema,
  validateBrainHealthFactorDelivery,
} from "../marketplace/a2a-live-match.js";

const jobId = process.argv[2];
if (!jobId || !/^\d+$/.test(jobId)) {
  throw new Error("Usage: npm run spike:validate-external-provider -- <ERC-8183-job-id> [account] [output-path]");
}
const account = process.argv[3] ?? "0xe02702687b1653a782af57fbcc56d59b7e99a935";
const outputPath = resolve(process.argv[4] ?? `/Users/qdee/Documents/Codex/competition-controls/build-the-era-positioncrew/audits/brain-on-bnb-delivery-validation-${jobId}.json`);
const response = await fetch(`https://agent.brainonbnb.com/job/${jobId}/result`, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(12_000),
});
if (!response.ok) throw new Error(`External deliverable returned HTTP ${response.status}`);
const rawDocument = await response.text();
const document = JSON.parse(rawDocument) as { result?: unknown };
if (!("result" in document)) throw new Error("External deliverable document has no result field");
const delivery = document.result;
const contentHash = `0x${createHash("sha256").update(rawDocument).digest("hex")}`;
const measuredAt = typeof delivery === "object" && delivery !== null
  && "position" in delivery && typeof delivery.position === "object" && delivery.position !== null
  && "measured_at" in delivery.position && typeof delivery.position.measured_at === "string"
  ? delivery.position.measured_at
  : new Date().toISOString();
const payment = brainOnBnbPaymentContract();
const frozenJob = HealthFactorLiveMatchJobSchema.parse({
  schemaVersion: "positioncrew.live-match.health-factor-job.v1",
  jobId: `pc-mainnet-${jobId}`,
  category: "HEALTH_FACTOR_MONITORING",
  chainId: 56,
  protocol: "Venus Classic",
  account,
  requestedAt: new Date(Date.parse(measuredAt) - 15 * 60_000).toISOString(),
  deadline: new Date(Date.parse(measuredAt) + 1_000).toISOString(),
  requiredOutputs: ["CURRENT_HEALTH_FACTOR", "LIQUIDATION_DISTANCE", "COLLATERAL_STRESS_TABLE", "PROTOCOL_CROSS_CHECK", "BLOCK_ATTRIBUTION"],
  maximumPrice: { amountAtomic: "100000000000000000", token: payment.paymentToken, chainId: 56 },
});
const validation = validateBrainHealthFactorDelivery(frozenJob, delivery);
const evidence = {
  schemaVersion: "positioncrew.live-match.external-delivery-validation.v1",
  recordedAt: new Date().toISOString(),
  chainId: 56,
  commerceJobId: jobId,
  provider: payment.provider,
  commerceKernel: payment.kernel,
  deliverableHash: "0x529ee17d8a32d5bfc41ef10987c01b639cfbeffcbe7f927093e669226213d090",
  submissionTransaction: "0x92805ddc2a123a893093e261427f18b57ec223b7f278e364882fe21f89e8fd5c",
  deliverableUrl: `https://agent.brainonbnb.com/job/${jobId}/result`,
  contentHash,
  contentHashMatchesOnchain: contentHash === "0x529ee17d8a32d5bfc41ef10987c01b639cfbeffcbe7f927093e669226213d090",
  frozenJob,
  validation,
  document,
  delivery,
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ outputPath, status: validation.status, checks: validation.checks, boundary: validation.boundary }, null, 2)}\n`);
