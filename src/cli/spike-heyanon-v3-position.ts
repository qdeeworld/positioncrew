import { auditionHeyAnonV3Position } from "../marketplace/heyanon-v3pools-adapter.js";

const positionId = process.argv[2];
if (!positionId) {
  throw new Error("Usage: npm run spike:heyanon-v3-position -- <pancake-v3-position-id>");
}
const assessment = await auditionHeyAnonV3Position(positionId);
process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
