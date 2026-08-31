import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { YieldOptimizationRequestSchema } from "../contracts/yield-optimization.js";
import { auditionHeyAnonBeefyForYieldRequest } from "../marketplace/heyanon-beefy-adapter.js";

const requestPath = resolve(
  process.argv[2] ?? "fixtures/yield-optimization/venus-to-beefy.v1.json",
);
const request = YieldOptimizationRequestSchema.parse(
  JSON.parse(await readFile(requestPath, "utf8")) as unknown,
);
const assessment = await auditionHeyAnonBeefyForYieldRequest(request);
process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
