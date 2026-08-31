import {
  evaluateHeyAnonCompatibility,
  probeHeyAnonVenus,
} from "../marketplace/heyanon-venus-adapter.js";

const account = process.argv[2] ?? "0xe02702687b1653a782af57fbcc56d59b7e99a935";
const positionCrewUrl = `https://positioncrew.dolepee.com/api/wallets/${account}/venus`;
const response = await fetch(positionCrewUrl, {
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`PositionCrew Venus probe returned HTTP ${response.status}`);
const positionCrew = await response.json() as {
  liquidityUsd: string;
  rescueRequest: Parameters<typeof probeHeyAnonVenus>[0];
  source: { blockNumber: string };
};
const snapshot = await probeHeyAnonVenus(positionCrew.rescueRequest);
const compatibility = evaluateHeyAnonCompatibility(
  positionCrew.rescueRequest,
  snapshot,
  positionCrew.liquidityUsd,
);

process.stdout.write(JSON.stringify({
  schemaVersion: "positioncrew.heyanon-readonly-spike.v1",
  positionCrew: {
    account,
    blockNumber: positionCrew.source.blockNumber,
    liquidityUsd: positionCrew.liquidityUsd,
  },
  snapshot,
  compatibility,
}, null, 2) + "\n");
