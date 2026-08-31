import {
  brainOnBnbPaymentContract,
  HealthFactorLiveMatchJobSchema,
  requestBrainHealthFactorQuote,
} from "../marketplace/a2a-live-match.js";

const account = process.argv[2];
if (!account) {
  throw new Error("Usage: npm run spike:external-provider -- <BSC Venus account>");
}

const now = new Date();
const payment = brainOnBnbPaymentContract();
const job = HealthFactorLiveMatchJobSchema.parse({
  schemaVersion: "positioncrew.live-match.health-factor-job.v1",
  jobId: `pc-live-match-${crypto.randomUUID()}`,
  category: "HEALTH_FACTOR_MONITORING",
  chainId: 56,
  protocol: "Venus Classic",
  account,
  requestedAt: now.toISOString(),
  deadline: new Date(now.getTime() + 5 * 60_000).toISOString(),
  requiredOutputs: [
    "CURRENT_HEALTH_FACTOR",
    "LIQUIDATION_DISTANCE",
    "COLLATERAL_STRESS_TABLE",
    "PROTOCOL_CROSS_CHECK",
    "BLOCK_ATTRIBUTION",
  ],
  maximumPrice: {
    amountAtomic: "100000000000000000",
    token: payment.paymentToken,
    chainId: 56,
  },
});

const trace = await requestBrainHealthFactorQuote(job);
process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
