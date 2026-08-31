import { auditionAiKiVenusGuardian } from "../marketplace/aiki-venus-guardian-adapter.js";
import { createLendingRescueDeliverable } from "../providers/lending-rescue.js";
import { inspectVenusAccount } from "../telemetry/bsc.js";

const account = process.argv[2] ?? "0xe02702687b1653a782af57fbcc56d59b7e99a935";
const probe = await inspectVenusAccount(account);
const firstParty = createLendingRescueDeliverable(probe.rescueRequest, new Date());
const external = await auditionAiKiVenusGuardian(probe.rescueRequest, firstParty);

console.log(
  JSON.stringify(
    {
      schemaVersion: "positioncrew.same-account-provider-comparison.v1",
      generatedAt: new Date().toISOString(),
      frozenRequest: probe.rescueRequest,
      positionCrew: { deliverable: firstParty },
      external,
      verdict: external.completedSamePositionAssessment
        ? "Two attributable providers completed comparable health assessments of the same live Venus account; rescue selection remains PositionCrew-only."
        : "The external provider did not complete a comparable health assessment.",
    },
    null,
    2,
  ),
);
