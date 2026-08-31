import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  brainOnBnbPaymentContract,
  HealthFactorLiveMatchJobSchema,
  validateBrainHealthFactorDelivery,
} from "../marketplace/a2a-live-match.js";

const jobId = process.argv[2];
const checkpointArgument = process.argv[3];
if (!jobId || !/^\d+$/.test(jobId) || !checkpointArgument) {
  throw new Error("Usage: npm run spike:validate-external-provider -- <ERC-8183-job-id> <activation-checkpoint> [output-path]");
}
const checkpointPath = resolve(checkpointArgument);
const outputPath = resolve(process.argv[4] ?? `brain-on-bnb-delivery-validation-${jobId}.json`);
const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Record<string, unknown>;
if (String(checkpoint.commerceJobId) !== jobId) {
  throw new Error("Activation checkpoint does not bind the requested ERC-8183 job ID");
}
const reaffirmationQuote = typeof checkpoint.reaffirmationQuote === "object" && checkpoint.reaffirmationQuote !== null
  ? checkpoint.reaffirmationQuote as Record<string, unknown>
  : null;
const frozenJob = HealthFactorLiveMatchJobSchema.parse(
  checkpoint.frozenJob ?? reaffirmationQuote?.frozenJob,
);
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
const payment = brainOnBnbPaymentContract();
const validation = validateBrainHealthFactorDelivery(frozenJob, delivery);
const evidence = {
  schemaVersion: "positioncrew.live-match.external-delivery-validation.v1",
  recordedAt: new Date().toISOString(),
  chainId: 56,
  commerceJobId: jobId,
  activationCheckpoint: checkpointPath,
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
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ outputPath, status: validation.status, checks: validation.checks, boundary: validation.boundary }, null, 2)}\n`);
