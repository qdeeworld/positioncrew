import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (requiredEnvironment("GITHUB_EVENT_NAME") !== "schedule") {
  throw new Error("Only protected scheduled runs may collect forward-shadow observations");
}

const baseUrl = new URL(
  process.env.POSITIONCREW_BASE_URL ?? "https://positioncrew.dolepee.com",
);
const endpoint = new URL(
  "/api/internal/bounded-grid-forward-shadow/tick",
  baseUrl,
);
const outputPath = resolve(
  process.env.POSITIONCREW_SHADOW_GRID_OUTPUT ??
    "/tmp/positioncrew-bounded-grid-forward-shadow-tick.json",
);

const response = await fetch(endpoint, {
  method: "POST",
  redirect: "error",
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${requiredEnvironment("SHADOW_GRID_TICK_TOKEN")}`,
    "User-Agent": "PositionCrew-Bounded-Grid-Forward-Shadow/1.0",
    "X-GitHub-Event": "schedule",
    "X-GitHub-Repository": requiredEnvironment("GITHUB_REPOSITORY"),
    "X-GitHub-Run-Id": requiredEnvironment("GITHUB_RUN_ID"),
    "X-GitHub-Run-Attempt": requiredEnvironment("GITHUB_RUN_ATTEMPT"),
    "X-GitHub-Sha": requiredEnvironment("GITHUB_SHA"),
    "X-GitHub-Workflow-Ref": requiredEnvironment("GITHUB_WORKFLOW_REF"),
  },
  signal: AbortSignal.timeout(45_000),
});

const body = await response.json().catch(() => null);
if (!response.ok) {
  throw new Error(
    `Forward-shadow tick returned HTTP ${response.status}: ${JSON.stringify(body)}`,
  );
}
if (
  body?.schemaVersion !== "positioncrew.bounded-grid-forward-shadow-tick.v1" ||
  body.accepted !== true ||
  typeof body.runId !== "string" ||
  !/^sha256:[a-f0-9]{64}$/u.test(body.headHash ?? "")
) {
  throw new Error("Forward-shadow tick returned an invalid response");
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
console.log(`Recorded protected forward-shadow tick ${body.runId}: ${body.state}`);
