import { inspectPancakePosition } from "../telemetry/bsc.js";
import { createLpRebalanceDeliverable } from "../providers/lp-rebalance.js";
import { auditionHeyAnonV3LpJob } from "../marketplace/heyanon-v3pools-lp-job-adapter.js";

const positionId = process.argv[2];
if (!positionId) {
  throw new Error("Usage: npm run spike:heyanon-v3-lp-job -- <pancake-v3-position-id>");
}
const probe = await inspectPancakePosition(positionId);
const firstParty = createLpRebalanceDeliverable(probe.lpRequest, new Date());
const external = await auditionHeyAnonV3LpJob(probe.lpRequest, positionId);
process.stdout.write(`${JSON.stringify({ probe, firstParty, external }, null, 2)}\n`);
