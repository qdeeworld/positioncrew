import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LpRebalanceRequestSchema } from "../src/contracts/lp-rebalance.js";
import { selectHeyAnonRangeShortcut } from "../src/marketplace/heyanon-v3pools-lp-job-adapter.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/lp-rebalance/out-of-range-v3-position.v1.json", import.meta.url), "utf8"));
describe("external preset admission uses the buyer's original limits", () => {
  it.each([[39, 237, "risky"], [100, 1500, "wide"], [500, 3000, "safe"]] as const)(
    "chooses the widest advertised preset fitting %d..%d ticks", (minimum, maximum, preset) => {
      const request = LpRebalanceRequestSchema.parse(structuredClone(fixture));
      Object.assign(request.constraints, { minimumWidthTicks: minimum, maximumWidthTicks: maximum, tickSpacing: 1 });
      const before = JSON.stringify(request);
      expect(selectHeyAnonRangeShortcut(request)).toBe(preset);
      expect(JSON.stringify(request)).toBe(before);
    },
  );
});
