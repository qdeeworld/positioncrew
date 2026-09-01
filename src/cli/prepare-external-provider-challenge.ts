import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAddress } from "viem";
import { canonicalHash } from "../core/canonical.js";
import {
  buildBrainHealthFactorQuoteRequest,
  HealthFactorLiveMatchJobSchema,
  requestBrainHealthFactorQuote,
} from "../marketplace/a2a-live-match.js";

const DEFAULT_ACCOUNT = getAddress("0xe02702687b1653a782af57fbcc56d59b7e99a935");
const PAYMENT_TOKEN = getAddress("0xcE24439F2D9C6a2289F741120FE202248B666666");
const MAXIMUM_PRICE_ATOMIC = "100000000000000000";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const account = getAddress(argument("account") ?? DEFAULT_ACCOUNT);
const now = new Date();
const frozenJob = HealthFactorLiveMatchJobSchema.parse({
  schemaVersion: "positioncrew.live-match.health-factor-job.v1",
  jobId: `pc-capability-${randomUUID()}`,
  category: "HEALTH_FACTOR_MONITORING",
  chainId: 56,
  protocol: "Venus Classic",
  account,
  requestedAt: now.toISOString(),
  deadline: new Date(now.getTime() + 30 * 60_000).toISOString(),
  requiredOutputs: [
    "CURRENT_HEALTH_FACTOR",
    "LIQUIDATION_DISTANCE",
    "COLLATERAL_STRESS_TABLE",
    "PROTOCOL_CROSS_CHECK",
    "BLOCK_ATTRIBUTION",
  ],
  maximumPrice: {
    amountAtomic: MAXIMUM_PRICE_ATOMIC,
    token: PAYMENT_TOKEN,
    chainId: 56,
  },
});
const nativeChallenge = buildBrainHealthFactorQuoteRequest(frozenJob);
const probeRequested = process.argv.includes("--probe-provider");
const providerProbe = probeRequested
  ? await requestBrainHealthFactorQuote(frozenJob)
  : null;
const checkpoint = {
  schemaVersion: "positioncrew.live-match.challenge-checkpoint.v1",
  preparedAt: now.toISOString(),
  state: "AWAITING_ZERO_VALUE_PROVIDER_PROOF",
  frozenJob,
  frozenJobHash: canonicalHash(frozenJob),
  nativeChallenge,
  nativeChallengeHash: canonicalHash(nativeChallenge),
  providerProbe,
  providerAdmission: providerProbe
    ? {
        highestProvenStage: "LIVE",
        compatible: false,
        activatable: false,
        selected: false,
        reason:
          "The provider returned a bounded quote but did not expose a zero-value provider-hosted result for category validation.",
      }
    : null,
  requiredProof: {
    schemaVersion: "positioncrew.live-match.prepayment-capability-proof.v1",
    providerAgentId: 302257,
    adapterId: "positioncrew:a2a:brain-on-bnb:health-factor:v1",
    financialValueAtomic: "0",
    providerNativePathPrefix: "/a2a/capability-proofs/",
  },
  boundary:
    "This checkpoint freezes a zero-value compatibility challenge. It creates no quote, job, approval, payment, signature, escrow, or transaction.",
};
const outputPath = resolve(
  argument("output") ?? `positioncrew-provider-challenge-${frozenJob.jobId}.json`,
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${json(checkpoint)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${json({
  outputPath,
  frozenJobHash: checkpoint.frozenJobHash,
  deadline: frozenJob.deadline,
  providerProbe: providerProbe ? "QUOTE_ONLY_NOT_COMPATIBLE" : "NOT_REQUESTED",
})}\n`);
