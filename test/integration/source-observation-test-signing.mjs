import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Explicit local integration fixture key; never imported by production code.
export const SOURCE_OBSERVATION_TEST_KEY = "positioncrew-d1-source-observation-explicit-test-key";
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../../src/commerce/server-observation-binding.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "es2022",
  logLevel: "silent",
});
const { issueServerObservationBinding } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);

export async function signSyntheticCurrentHire(payload, now = new Date()) {
  return {
    ...payload,
    observationBinding: await issueServerObservationBinding(
      payload.request,
      payload.observation,
      SOURCE_OBSERVATION_TEST_KEY,
      now,
    ),
  };
}
