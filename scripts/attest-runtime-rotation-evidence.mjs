import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "dolepee/positioncrew";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "evidence/termix-runtime-rotations.mainnet.json"),
    "utf8",
  ),
);
const rotationManifest = JSON.parse(
  await readFile(
    resolve(
      repositoryRoot,
      "evidence/termix-runtime-rotation-events.manifest.json",
    ),
    "utf8",
  ),
);
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function githubJson(path) {
  assert(token, "GH_TOKEN or GITHUB_TOKEN is required");
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "PositionCrew-Runtime-Evidence-Attestor/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (
        attempt < 4 &&
        (response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel();
        await sleep(500 * attempt);
        continue;
      }
      const body = await response.json().catch(() => null);
      assert(response.ok, `GitHub API ${path} returned HTTP ${response.status}`);
      assert(
        body && typeof body === "object",
        `GitHub API ${path} returned invalid JSON`,
      );
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === 4) throw error;
      await sleep(500 * attempt);
    }
  }
  throw lastError;
}

assert(
  process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY === repository,
  `Refusing attestation from unexpected repository ${process.env.GITHUB_REPOSITORY}`,
);
assert(
  evidence.schemaVersion === "positioncrew.termix-runtime-rotations.v1" &&
    evidence.rotations?.length >= 3,
  "Runtime rotation evidence is missing",
);
assert(
  rotationManifest.schemaVersion ===
    "positioncrew.termix-runtime-rotation-events.v1" &&
    rotationManifest.network === evidence.network &&
    rotationManifest.chainId === evidence.chainId &&
    rotationManifest.service === evidence.service &&
    rotationManifest.role === evidence.role &&
    rotationManifest.agentId === evidence.agentId &&
    rotationManifest.agentTokenId === evidence.agentTokenId &&
    rotationManifest.runtimeInstance === evidence.runtimeInstance &&
    rotationManifest.eventName === evidence.eventName &&
    rotationManifest.redactedJournalEventCanonicalization ===
      evidence.redactedJournalEventCanonicalization &&
    rotationManifest.rotations?.length === evidence.rotations.length,
  "Canonical rotation-event manifest is missing or unbound",
);

const authenticated = [];
for (const [index, rotation] of evidence.rotations.entries()) {
  const manifestRotation = rotationManifest.rotations[index];
  const canonicalJournalEvent = JSON.stringify({
    at: rotation.completedAt,
    event: evidence.eventName,
    agentId: evidence.agentId,
    runtimeInstance: evidence.runtimeInstance,
    rotated: rotation.rotated,
    restarted: rotation.restarted,
    expiresAt: rotation.expiresAt,
  });
  assert(
    manifestRotation.sequence === rotation.sequence &&
      manifestRotation.completedAt === rotation.completedAt &&
      manifestRotation.expiresAt === rotation.expiresAt &&
      manifestRotation.rotated === rotation.rotated &&
      manifestRotation.restarted === rotation.restarted &&
      manifestRotation.redactedJournalEventSha256 ===
        rotation.redactedJournalEventSha256 &&
      sha256(canonicalJournalEvent) === rotation.redactedJournalEventSha256,
    `Canonical manifest does not match rotation ${rotation.sequence}`,
  );
  const observation = rotation.onlineObservation;
  const runEvidence = observation.githubRun;
  const artifactEvidence = observation.artifact;
  const reportEvidence = observation.healthReport;
  const run = await githubJson(`/actions/runs/${observation.runId}`);
  assert(
    String(run.id) === observation.runId &&
      String(run.workflow_id) === runEvidence.workflowId &&
      run.path === runEvidence.workflowPath &&
      run.event === "schedule" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.head_branch === "main" &&
      run.head_sha === runEvidence.headSha &&
      run.run_attempt === runEvidence.runAttempt &&
      run.html_url === observation.url,
    `Run ${observation.runId} is not the committed scheduled-success run`,
  );
  const artifact = await githubJson(`/actions/artifacts/${artifactEvidence.id}`);
  assert(
    String(artifact.id) === artifactEvidence.id &&
      artifact.name === artifactEvidence.name &&
      artifact.expired === false &&
      artifact.digest === `sha256:${artifactEvidence.archiveSha256}` &&
      artifact.size_in_bytes === artifactEvidence.sizeBytes &&
      String(artifact.workflow_run?.id) === observation.runId &&
      artifact.workflow_run?.head_sha === runEvidence.headSha,
    `Artifact ${artifactEvidence.id} is not bound to run ${observation.runId}`,
  );
  const archivePath = resolve(repositoryRoot, artifactEvidence.archivePath);
  const archive = await readFile(archivePath);
  assert(
    archive.length === artifactEvidence.sizeBytes &&
      sha256(archive) === artifactEvidence.archiveSha256,
    `Preserved ZIP for run ${observation.runId} does not match GitHub's digest`,
  );
  const report = execFileSync(
    "unzip",
    ["-p", archivePath, artifactEvidence.reportFileName],
    { maxBuffer: 1_000_000 },
  );
  assert(
    sha256(report) === artifactEvidence.reportSha256,
    `Health report for run ${observation.runId} failed digest verification`,
  );
  const parsedReport = JSON.parse(report.toString("utf8"));
  const flagship = parsedReport.aacpReadiness?.marketplace?.dedicatedFlagship;
  assert(
    parsedReport.schemaVersion === reportEvidence.schemaVersion &&
      parsedReport.baseUrl === reportEvidence.baseUrl &&
      parsedReport.checkedAt === reportEvidence.checkedAt &&
      parsedReport.completedAt === reportEvidence.completedAt &&
      parsedReport.status === "OPERATIONAL" &&
      parsedReport.error === null &&
      parsedReport.aacpReadiness?.generatedAt === observation.observedAt &&
      flagship?.agentId === evidence.agentId &&
      flagship?.agentTokenId === evidence.agentTokenId &&
      flagship?.listingStatus === "PUBLISHED" &&
      flagship?.a2aStatus === "ONLINE" &&
      flagship?.status === "ONLINE_AND_LISTED",
    `Health report for run ${observation.runId} does not prove the flagship observation`,
  );
  authenticated.push({
    runId: observation.runId,
    artifactId: artifactEvidence.id,
    archiveSha256: artifactEvidence.archiveSha256,
    reportSha256: artifactEvidence.reportSha256,
  });
}

console.log(
  JSON.stringify({
    status: "AUTHENTICATED_FOR_GITHUB_ATTESTATION",
    repository,
    sourceCommit: process.env.GITHUB_SHA ?? null,
    rotations: authenticated,
    rotationManifest: {
      path: "evidence/termix-runtime-rotation-events.manifest.json",
      sha256: sha256(
        await readFile(
          resolve(
            repositoryRoot,
            "evidence/termix-runtime-rotation-events.manifest.json",
          ),
        ),
      ),
    },
  }),
);
