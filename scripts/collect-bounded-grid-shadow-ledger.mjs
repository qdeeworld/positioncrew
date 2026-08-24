import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WORKFLOW_REF =
  "dolepee/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main";
const TICK_SCHEMA = "positioncrew.bounded-grid-forward-shadow-tick.v1";
const SESSION_SCHEMA = "positioncrew.bounded-grid-forward-shadow-scheduled-session.v1";
const OFFSETS = [0, 5, 10, 15];
const TERMINAL = new Set([
  "LATE_START_SKIPPED",
  "REFUSED",
  "VOID_SOURCE_GAP",
  "RISK_EXIT",
  "CLOSED",
]);
const HASH = /^sha256:[a-f0-9]{64}$/u;

function value(environment, name) {
  const candidate = environment[name];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function required(environment, name) {
  const candidate = value(environment, name);
  if (!candidate) throw new Error(`${name} is required`);
  return candidate;
}

function milliseconds(now) {
  const candidate = now();
  const result = candidate instanceof Date ? candidate.getTime() : Number(candidate);
  if (!Number.isFinite(result)) throw new Error("Scheduled-session clock is invalid");
  return result;
}

function iso(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Scheduled-session timestamp is invalid");
  return date.toISOString();
}

function runIdAt(timestamp) {
  const timestampIso = iso(timestamp);
  return `bg-${timestampIso.slice(0, 10).replaceAll("-", "")}-${timestampIso.slice(11, 13)}`;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function identitySnapshot(environment) {
  return {
    eventName: value(environment, "GITHUB_EVENT_NAME"),
    repository: value(environment, "GITHUB_REPOSITORY"),
    runId: value(environment, "GITHUB_RUN_ID"),
    runAttempt: value(environment, "GITHUB_RUN_ATTEMPT"),
    headSha: value(environment, "GITHUB_SHA")?.toLowerCase() ?? null,
    workflowRef: value(environment, "GITHUB_WORKFLOW_REF"),
  };
}

function validatedIdentity(environment) {
  const identity = {
    eventName: required(environment, "GITHUB_EVENT_NAME"),
    repository: required(environment, "GITHUB_REPOSITORY"),
    runId: required(environment, "GITHUB_RUN_ID"),
    runAttempt: required(environment, "GITHUB_RUN_ATTEMPT"),
    headSha: required(environment, "GITHUB_SHA").toLowerCase(),
    workflowRef: required(environment, "GITHUB_WORKFLOW_REF"),
  };
  if (identity.eventName !== "schedule") {
    throw new Error("Only an authentic scheduled workflow run may collect forward-shadow observations");
  }
  if (identity.repository !== "dolepee/positioncrew") {
    throw new Error("Forward-shadow collection is restricted to dolepee/positioncrew");
  }
  if (!/^\d+$/u.test(identity.runId)) throw new Error("GITHUB_RUN_ID is invalid");
  if (identity.runAttempt !== "1") {
    throw new Error("Workflow reruns cannot collect forward-shadow observations");
  }
  if (!/^[a-f0-9]{40}$/u.test(identity.headSha)) throw new Error("GITHUB_SHA is invalid");
  if (identity.workflowRef !== WORKFLOW_REF) {
    throw new Error("Forward-shadow collection requires the fixed production-smoke workflow identity");
  }
  return identity;
}

function validatedTick(body) {
  if (typeof body !== "object" || body === null) {
    throw new Error("Forward-shadow tick returned a non-object response");
  }
  const late = body.state === "LATE_START_SKIPPED";
  const stateIsValid = body.state === "PRECOMMITTED" || TERMINAL.has(body.state);
  const boundaryIsValid = Array.isArray(body.claimBoundary) &&
    body.claimBoundary.length > 0 &&
    body.claimBoundary.every((entry) => typeof entry === "string");
  if (
    body.schemaVersion !== TICK_SCHEMA ||
    body.accepted !== true ||
    typeof body.runId !== "string" ||
    !/^bg-\d{8}-\d{2}$/u.test(body.runId) ||
    !stateIsValid ||
    !Number.isInteger(body.eventCount) ||
    body.eventCount < 0 ||
    !boundaryIsValid
  ) {
    throw new Error("Forward-shadow tick returned an invalid response");
  }
  if (late) {
    if (
      body.headHash !== null ||
      body.eventCount !== 0 ||
      body.epochStartedAt !== null ||
      body.horizonEndsAt !== null
    ) {
      throw new Error("Late-start response contains persisted epoch state");
    }
    return body;
  }
  if (
    !HASH.test(body.headHash ?? "") ||
    typeof body.epochStartedAt !== "string" ||
    typeof body.horizonEndsAt !== "string"
  ) {
    throw new Error("Forward-shadow tick omitted its persisted epoch binding");
  }
  const started = Date.parse(body.epochStartedAt);
  const horizon = Date.parse(body.horizonEndsAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(horizon) ||
    horizon - started !== 15 * 60_000 ||
    runIdAt(started) !== body.runId
  ) {
    throw new Error("Forward-shadow tick returned an invalid epoch horizon");
  }
  return body;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

async function defaultSleep(delay) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
}

async function sleepUntil(target, now, sleep) {
  let previous = milliseconds(now);
  while (previous < target) {
    await sleep(target - previous);
    const current = milliseconds(now);
    if (current <= previous) throw new Error("Scheduled-session clock did not advance while waiting");
    previous = current;
  }
}

function filePersister(outputPath) {
  return async (artifact) => {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  };
}

export async function runShadowGridScheduledSession(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const retryDelay = options.retryDelayMilliseconds ?? 5_000;
  const requestTimeout = options.requestTimeoutMilliseconds ?? 45_000;
  const outputPath = resolve(
    environment.POSITIONCREW_SHADOW_GRID_OUTPUT ??
      "/tmp/positioncrew-bounded-grid-forward-shadow-session.json",
  );
  const persistArtifact = options.persistArtifact ?? filePersister(outputPath);
  const artifact = {
    schemaVersion: SESSION_SCHEMA,
    status: "INITIALIZING",
    finalStatus: null,
    startedAt: iso(milliseconds(now)),
    finishedAt: null,
    identity: identitySnapshot(environment),
    endpoint: null,
    runId: null,
    epochStartedAt: null,
    horizonEndsAt: null,
    targets: OFFSETS.map((offsetMinutes) => ({ offsetMinutes, targetAt: null })),
    attempts: [],
    claimBoundary: [],
    failure: null,
  };
  const persist = () => persistArtifact(structuredClone(artifact));

  try {
    const identity = validatedIdentity(environment);
    artifact.identity = identity;
    const endpoint = new URL(
      "/api/internal/bounded-grid-forward-shadow/tick",
      new URL(environment.POSITIONCREW_BASE_URL ?? "https://positioncrew.dolepee.com"),
    );
    if (endpoint.search !== "") throw new Error("Forward-shadow endpoint must not contain query input");
    artifact.endpoint = endpoint.toString();
    artifact.status = "RUNNING";
    await persist();

    const headers = Object.freeze({
      Accept: "application/json",
      Authorization: `Bearer ${required(environment, "SHADOW_GRID_TICK_TOKEN")}`,
      "User-Agent": "PositionCrew-Bounded-Grid-Forward-Shadow/2.0",
      "X-GitHub-Event": identity.eventName,
      "X-GitHub-Repository": identity.repository,
      "X-GitHub-Run-Id": identity.runId,
      "X-GitHub-Run-Attempt": identity.runAttempt,
      "X-GitHub-Sha": identity.headSha,
      "X-GitHub-Workflow-Ref": identity.workflowRef,
    });

    const requestTick = async (targetOffsetMinutes, expected) => {
      for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
        if (expected && runIdAt(milliseconds(now)) !== expected.runId) {
          throw new Error("Scheduled session crossed its initial UTC-hour run ID");
        }
        const requestedAt = iso(milliseconds(now));
        let response;
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            redirect: "error",
            headers,
            signal: AbortSignal.timeout(requestTimeout),
          });
        } catch (error) {
          artifact.attempts.push({
            targetOffsetMinutes,
            attemptNumber,
            requestedAt,
            completedAt: iso(milliseconds(now)),
            outcome: "NETWORK_ERROR",
            httpStatus: null,
            response: null,
            error: message(error),
          });
          await persist();
          if (attemptNumber === 1) {
            await sleep(retryDelay);
            continue;
          }
          throw new Error(`Forward-shadow tick failed after one retry: ${message(error)}`);
        }

        let body = null;
        let parseError = null;
        try {
          body = await response.json();
        } catch (error) {
          parseError = message(error);
        }
        if (!response.ok) {
          artifact.attempts.push({
            targetOffsetMinutes,
            attemptNumber,
            requestedAt,
            completedAt: iso(milliseconds(now)),
            outcome: "HTTP_ERROR",
            httpStatus: response.status,
            response: body,
            error: parseError ?? `HTTP ${response.status}`,
          });
          await persist();
          if (response.status >= 500 && response.status <= 599 && attemptNumber === 1) {
            await sleep(retryDelay);
            continue;
          }
          throw new Error(`Forward-shadow tick returned HTTP ${response.status}: ${JSON.stringify(body)}`);
        }
        if (parseError) {
          artifact.attempts.push({
            targetOffsetMinutes,
            attemptNumber,
            requestedAt,
            completedAt: iso(milliseconds(now)),
            outcome: "INVALID_RESPONSE",
            httpStatus: response.status,
            response: null,
            error: parseError,
          });
          await persist();
          throw new Error(`Forward-shadow tick returned invalid JSON: ${parseError}`);
        }

        let tick;
        try {
          tick = validatedTick(body);
          if (
            expected &&
            (tick.runId !== expected.runId ||
              tick.epochStartedAt !== expected.epochStartedAt ||
              tick.horizonEndsAt !== expected.horizonEndsAt)
          ) {
            throw new Error("Forward-shadow tick changed its persisted epoch binding");
          }
          if (
            artifact.claimBoundary.length > 0 &&
            !sameArray(artifact.claimBoundary, tick.claimBoundary)
          ) {
            throw new Error("Forward-shadow tick changed its public claim boundary");
          }
        } catch (error) {
          artifact.attempts.push({
            targetOffsetMinutes,
            attemptNumber,
            requestedAt,
            completedAt: iso(milliseconds(now)),
            outcome: "INVALID_RESPONSE",
            httpStatus: response.status,
            response: body,
            error: message(error),
          });
          await persist();
          throw error;
        }

        artifact.claimBoundary = [...tick.claimBoundary];
        artifact.attempts.push({
          targetOffsetMinutes,
          attemptNumber,
          requestedAt,
          completedAt: iso(milliseconds(now)),
          outcome: "ACCEPTED",
          httpStatus: response.status,
          response: body,
          error: null,
        });
        await persist();
        return tick;
      }
      throw new Error("Forward-shadow tick exhausted its bounded retry policy");
    };

    const opening = await requestTick(0, null);
    artifact.runId = opening.runId;
    if (opening.state === "LATE_START_SKIPPED") {
      artifact.status = "COMPLETED";
      artifact.finalStatus = opening.state;
      artifact.finishedAt = iso(milliseconds(now));
      await persist();
      return artifact;
    }

    artifact.epochStartedAt = opening.epochStartedAt;
    artifact.horizonEndsAt = opening.horizonEndsAt;
    const epoch = Date.parse(opening.epochStartedAt);
    artifact.targets = OFFSETS.map((offsetMinutes) => ({
      offsetMinutes,
      targetAt: iso(epoch + offsetMinutes * 60_000),
    }));
    await persist();
    const expected = {
      runId: opening.runId,
      epochStartedAt: opening.epochStartedAt,
      horizonEndsAt: opening.horizonEndsAt,
    };
    let latest = opening;
    if (!TERMINAL.has(latest.state)) {
      for (const offsetMinutes of OFFSETS.slice(1)) {
        await sleepUntil(epoch + offsetMinutes * 60_000, now, sleep);
        if (runIdAt(milliseconds(now)) !== expected.runId) {
          throw new Error("Scheduled session crossed its initial UTC-hour run ID");
        }
        latest = await requestTick(offsetMinutes, expected);
        if (TERMINAL.has(latest.state)) break;
      }
    }
    if (!TERMINAL.has(latest.state)) {
      throw new Error("Scheduled shadow-grid session ended without a terminal ledger state");
    }
    artifact.status = "COMPLETED";
    artifact.finalStatus = latest.state;
    artifact.finishedAt = iso(milliseconds(now));
    await persist();
    return artifact;
  } catch (error) {
    artifact.status = "FAILED";
    artifact.failure = message(error);
    artifact.finishedAt = iso(milliseconds(now));
    await persist();
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const artifact = await runShadowGridScheduledSession();
  console.log(
    artifact.finalStatus === "LATE_START_SKIPPED"
      ? `Skipped late forward-shadow opening ${artifact.runId}; no retrospective window was created`
      : `Completed protected forward-shadow session ${artifact.runId}: ${artifact.finalStatus}`,
  );
}
