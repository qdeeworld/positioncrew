import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { requestBnbLpRangeQuote } from "../marketplace/bnb-lp-range-a2a-adapter.js";
import { inspectPancakePosition } from "../telemetry/bsc.js";

const positionId = process.argv[2] ?? "1456267";
const outputArgument = process.argv[3];
const probe = await inspectPancakePosition(positionId);
const quote = await requestBnbLpRangeQuote(probe.lpRequest);
const evidence = {
  schemaVersion: "positioncrew.live-match.lp-provider-spike.v1",
  recordedAt: new Date().toISOString(),
  positionId,
  source: probe.source,
  quote,
  nextGate: {
    status: "FUNDING_NOT_AUTHORIZED",
    requirements: [
      "Refresh and freeze the current LP request immediately before activation.",
      "Obtain an identity-bound signed quote within the frozen maximum price.",
      "Fund only through the reviewed ERC-8183 rail under an explicit transaction cap.",
      "Accept no provider until its attributable delivery passes the exact LP output contract.",
    ],
  },
  boundary:
    "This is a zero-value provider negotiation. It creates no job, approval, escrow, payment, provider selection, LP action, or transaction.",
};

if (outputArgument) {
  const outputPath = resolve(outputArgument);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({ outputPath, quote: quote.states, boundary: evidence.boundary }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
