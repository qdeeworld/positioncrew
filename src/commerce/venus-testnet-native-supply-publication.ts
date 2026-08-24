import artifact from "../../evidence/venus-testnet-native-supply.2026-08-24.json" with { type: "json" };
import {
  verifyVenusTestnetNativeSupplyEvidence,
  type VenusTestnetNativeSupplyEvidence,
} from "./venus-testnet-native-supply-evidence.js";

export const VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE_ROUTE =
  "/api/evidence/venus-testnet-native-supply/2026-08-24" as const;
export const VENUS_TESTNET_NATIVE_SUPPLY_ARTIFACT_HASH =
  "sha256:cc1239e1932aac886eee9365303f65f4903991389bdd73b507c9ba3108988976" as const;
export const VENUS_TESTNET_NATIVE_SUPPLY_TRANSACTION_HASH =
  "0xf2b4a8790ff7f81fc832a365d89eb84f0554d2242c45faa886ba6819acb1773b" as const;
export const VENUS_TESTNET_NATIVE_SUPPLY_PUBLIC_CLAIM_BOUNDARY =
  "Optional sponsor and execution evidence for one disclosed-operator Venus action on BSC Testnet using exactly 0.0001 tBNB; it proves no mainnet funds, external buyer, revenue, autonomous custody, strategy return, repeated track record, marketplace demand, or financial performance." as const;

const parsed = verifyVenusTestnetNativeSupplyEvidence(artifact);
if (parsed.commitments.artifactHash !== VENUS_TESTNET_NATIVE_SUPPLY_ARTIFACT_HASH) {
  throw new Error("Published Venus receipt artifact commitment changed");
}
if (parsed.transaction.hash !== VENUS_TESTNET_NATIVE_SUPPLY_TRANSACTION_HASH) {
  throw new Error("Published Venus receipt transaction changed");
}
if (
  parsed.relationship !== "FOUNDER_CONTROLLED_TESTNET_ACTION" ||
  parsed.intent.transaction.amountTbnb !== "0.0001" ||
  parsed.intent.transaction.valueWei !== "100000000000000" ||
  parsed.actor.externalBuyer !== false ||
  parsed.intent.preflight.mainnetIsolation.nativeBalanceWei !== "0" ||
  parsed.intent.preflight.mainnetIsolation.pendingNonce !== "0"
) {
  throw new Error("Published Venus receipt claim boundary changed");
}

const serializedArtifact = JSON.stringify(parsed);
const forbiddenPublicationMaterial = [
  /"rawTransaction"\s*:/i,
  /"(?:private[-_ ]?key|password|keystore|mnemonic|seed[-_ ]?phrase|secret)"\s*:/i,
  /(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\\\)/,
];
if (forbiddenPublicationMaterial.some((pattern) => pattern.test(serializedArtifact))) {
  throw new Error("Published Venus receipt contains private or local operator material");
}

export const VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE: VenusTestnetNativeSupplyEvidence =
  Object.freeze(parsed);
