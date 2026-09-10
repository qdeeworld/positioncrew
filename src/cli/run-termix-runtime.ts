import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchownSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TERMIX_RUNTIME_DEFAULT_POLL_SECONDS,
  TERMIX_RUNTIME_MIN_POLL_SECONDS,
  TermixRuntimeClient,
  TermixRuntimeHttpError,
  TermixRuntimeTransportError,
  TermixRuntimeTokenError,
  TermixRuntimeStateSchema,
  assertRuntimeTokenFresh,
  buildTermixRuntimeDecision,
  createTermixRuntimeState,
  hasProcessedRuntimeMessage,
  recordTermixRuntimeDecision,
  recordTermixRuntimePoll,
  runtimePollSince,
  type PositionCrewService,
  type TermixRuntimeTransport,
  type TermixRuntimeState,
} from "../commerce/aacp-runtime.js";
import { ServiceTypeSchema } from "../contracts/common.js";

interface RuntimeEnvironment {
  agentId: string;
  service: PositionCrewService;
  token: string;
  tokenExpiresAt: string | undefined;
  baseUrl: string;
  origin: string;
  statePath: string;
  pollSeconds: number;
  once: boolean;
}

export const TERMIX_RUNTIME_CREDENTIAL_EXIT_CODE = 78;

export class TermixRuntimeCredentialFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TermixRuntimeCredentialFileError";
  }
}

function credentialFileError(message: string): never {
  throw new TermixRuntimeCredentialFileError(message);
}

export interface ProtectedRuntimeFilePolicy {
  expectedOwnerUserId?: number;
  trustedRoot?: string;
}

function assertTrustedRuntimePath(
  path: string,
  label: string,
  policy: ProtectedRuntimeFilePolicy,
): void {
  if (!policy.trustedRoot) return;
  const normalizedPath = resolve(path);
  const trustedRoot = resolve(policy.trustedRoot);
  if (normalizedPath !== path) {
    credentialFileError(`${label} must use a normalized absolute path`);
  }
  const parent = dirname(normalizedPath);
  const descendant = relative(trustedRoot, parent);
  if (descendant === ".." || descendant.startsWith(`..${sep}`) || isAbsolute(descendant)) {
    credentialFileError(`${label} must be below its trusted root`);
  }

  let current = trustedRoot;
  for (const component of descendant.split(sep).filter(Boolean)) {
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      credentialFileError(`${label} trusted path must contain only real directories`);
    }
    if (
      policy.expectedOwnerUserId !== undefined &&
      stats.uid !== policy.expectedOwnerUserId
    ) {
      credentialFileError(`${label} trusted path must be owned by UID ${policy.expectedOwnerUserId}`);
    }
    if ((stats.mode & 0o022) !== 0) {
      credentialFileError(`${label} trusted path must not be writable by group or others`);
    }
    current = join(current, component);
  }
  const parentStats = lstatSync(current);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    credentialFileError(`${label} trusted path must contain only real directories`);
  }
  if (
    policy.expectedOwnerUserId !== undefined &&
    parentStats.uid !== policy.expectedOwnerUserId
  ) {
    credentialFileError(`${label} trusted path must be owned by UID ${policy.expectedOwnerUserId}`);
  }
  if ((parentStats.mode & 0o022) !== 0) {
    credentialFileError(`${label} trusted path must not be writable by group or others`);
  }
}

function readProtectedRegularFile(
  path: string,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
  policy: ProtectedRuntimeFilePolicy = {},
): string {
  if (!isAbsolute(path)) {
    credentialFileError(`${label} must be an absolute path`);
  }
  assertTrustedRuntimePath(path, label, policy);
  const pathStats = lstatSync(path);
  if (!pathStats.isFile()) {
    credentialFileError(`${label} must reference a regular file`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStats = fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      credentialFileError(`${label} changed while it was being validated`);
    }
    if ((openedStats.mode & 0o077) !== 0) {
      credentialFileError(`${label} must not be accessible by group or others`);
    }
    if (
      policy.expectedOwnerUserId !== undefined &&
      openedStats.uid !== policy.expectedOwnerUserId
    ) {
      credentialFileError(`${label} must be owned by UID ${policy.expectedOwnerUserId}`);
    }
    if (openedStats.size < minimumBytes || openedStats.size > maximumBytes) {
      credentialFileError(`${label} has an invalid size`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function readProtectedRuntimeToken(path: string): string {
  const token = readProtectedRegularFile(
    path,
    "TERMIX_A2A_RUNTIME_TOKEN_FILE",
    16,
    4_096,
  ).trim();
  if (token.length < 16 || /\s/.test(token)) {
    credentialFileError("TERMIX_A2A_RUNTIME_TOKEN_FILE contains a malformed token");
  }
  return token;
}

export function validateProtectedRuntimeTokenFile(
  path: string,
  policy: ProtectedRuntimeFilePolicy = {},
): void {
  const token = readProtectedRegularFile(
    path,
    "TERMIX_A2A_RUNTIME_TOKEN_FILE",
    16,
    4_096,
    policy,
  ).trim();
  if (token.length < 16 || /\s/.test(token)) {
    credentialFileError("TERMIX_A2A_RUNTIME_TOKEN_FILE contains a malformed token");
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseStateFile(
  path: string,
  label: string,
  agentId: string,
  service: PositionCrewService,
): TermixRuntimeState {
  const state = TermixRuntimeStateSchema.parse(
    JSON.parse(readProtectedRegularFile(path, label, 2, 1_048_576)) as unknown,
  );
  if (state.agentId !== agentId || state.service !== service) {
    throw new Error(`${label} belongs to another agent or service`);
  }
  return state;
}

export function migrateLegacyRuntimeState(
  sourcePath: string,
  targetPath: string,
  agentId: string,
  service: PositionCrewService,
): "SOURCE_MISSING" | "TARGET_PRESENT" | "MIGRATED" {
  if (!isAbsolute(sourcePath) || !isAbsolute(targetPath) || sourcePath === targetPath) {
    throw new Error("Runtime state migration requires distinct absolute source and target paths");
  }
  const requestedParent = dirname(targetPath);
  const requestedParentStats = lstatSync(requestedParent);
  const resolvedParent = realpathSync(requestedParent);
  if (requestedParentStats.isSymbolicLink()) {
    const expectedDynamicUserTarget = join(
      dirname(requestedParent),
      "private",
      basename(requestedParent),
    );
    if (resolvedParent !== realpathSync(expectedDynamicUserTarget)) {
      throw new Error("Runtime state directory symlink is not the systemd DynamicUser target");
    }
    if (process.geteuid?.() === 0) {
      const linkContainerStats = statSync(dirname(requestedParent));
      if (
        requestedParentStats.uid !== 0 ||
        linkContainerStats.uid !== 0 ||
        (linkContainerStats.mode & 0o022) !== 0
      ) {
        throw new Error("Runtime state directory symlink must be controlled by root");
      }
    }
  }
  const parentStats = statSync(resolvedParent);
  if (!parentStats.isDirectory()) {
    throw new Error("Runtime state target parent must resolve to a directory");
  }
  const resolvedTargetPath = join(resolvedParent, basename(targetPath));

  if (lstatIfPresent(resolvedTargetPath)) {
    parseStateFile(resolvedTargetPath, "TERMIX_A2A_STATE_PATH", agentId, service);
    return "TARGET_PRESENT";
  }
  if (!lstatIfPresent(sourcePath)) return "SOURCE_MISSING";
  const state = parseStateFile(sourcePath, "legacy runtime state", agentId, service);
  const temporaryPath = join(
    resolvedParent,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let temporaryCreated = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    const createdStats = fstatSync(descriptor);
    if (createdStats.uid !== parentStats.uid || createdStats.gid !== parentStats.gid) {
      fchownSync(descriptor, parentStats.uid, parentStats.gid);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporaryPath, resolvedTargetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      unlinkSync(temporaryPath);
      temporaryCreated = false;
      parseStateFile(resolvedTargetPath, "TERMIX_A2A_STATE_PATH", agentId, service);
      return "TARGET_PRESENT";
    }
    unlinkSync(temporaryPath);
    temporaryCreated = false;
    return "MIGRATED";
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryCreated) {
      try {
        unlinkSync(temporaryPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
    throw error;
  }
}

function runtimeTokenFileArgument(argv: string[]): string | undefined {
  const flag = "--runtime-token-file";
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  if (argv.indexOf(flag, index + 1) !== -1) {
    throw new Error("--runtime-token-file may be provided only once");
  }
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error("--runtime-token-file requires an absolute path");
  }
  return value;
}

export function runtimeExitCode(error: unknown): number {
  return error instanceof TermixRuntimeTokenError ||
      error instanceof TermixRuntimeCredentialFileError
    ? TERMIX_RUNTIME_CREDENTIAL_EXIT_CODE
    : 1;
}

function runtimeBundleEntryPoint(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const compiledSuffix = `${sep}dist${sep}cli${sep}run-termix-runtime.js`;
  return modulePath.endsWith(compiledSuffix)
    ? resolve(dirname(modulePath), "../../src/cli/run-termix-runtime.ts")
    : modulePath;
}

export async function bundleRuntimeArtifact(outputPath: string): Promise<void> {
  if (!isAbsolute(outputPath)) {
    throw new Error("--bundle-runtime-artifact requires an absolute output path");
  }
  const entryPoint = runtimeBundleEntryPoint();
  const projectRoot = resolve(dirname(entryPoint), "../..");
  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["esbuild"],
    legalComments: "none",
    minify: true,
    sourcemap: false,
    write: false,
  });
  if (result.outputFiles.length !== 1 || !result.outputFiles[0]) {
    throw new Error("Runtime bundling did not produce exactly one artifact");
  }
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    await writeFile(temporaryPath, result.outputFiles[0].contents, {
      flag: "wx",
      mode: 0o600,
    });
    temporaryCreated = true;
    await rename(temporaryPath, outputPath);
    temporaryCreated = false;
  } catch (error) {
    if (temporaryCreated) {
      try {
        unlinkSync(temporaryPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
    throw error;
  }
}

export function parseRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): RuntimeEnvironment {
  if (env.WALLET_KEY || env.PRIVATE_KEY) {
    throw new Error("Refusing to start: the runtime host must not receive an owner private key");
  }
  const agentId = env.TERMIX_A2A_AGENT_ID?.trim();
  const environmentToken = env.TERMIX_A2A_RUNTIME_TOKEN?.trim();
  const environmentTokenFile = env.TERMIX_A2A_RUNTIME_TOKEN_FILE?.trim();
  const argumentTokenFile = runtimeTokenFileArgument(argv);
  if (argumentTokenFile && environmentTokenFile) {
    throw new Error(
      "Refusing to start: --runtime-token-file conflicts with TERMIX_A2A_RUNTIME_TOKEN_FILE",
    );
  }
  const tokenFile = argumentTokenFile || environmentTokenFile;
  if (environmentToken && tokenFile) {
    throw new Error(
      "Refusing to start: provide either TERMIX_A2A_RUNTIME_TOKEN or TERMIX_A2A_RUNTIME_TOKEN_FILE, not both",
    );
  }
  const token = environmentToken || (tokenFile ? readProtectedRuntimeToken(tokenFile) : undefined);
  const service = ServiceTypeSchema.safeParse(env.POSITIONCREW_SERVICE?.trim());
  if (!agentId) throw new Error("TERMIX_A2A_AGENT_ID is required");
  if (!token) throw new Error("TERMIX_A2A_RUNTIME_TOKEN is required");
  if (!service.success) {
    throw new Error(
      "POSITIONCREW_SERVICE must be LENDING_RESCUE, LP_REBALANCE, YIELD_OPTIMIZATION, or BOUNDED_GRID",
    );
  }
  const pollSeconds = Number(env.TERMIX_A2A_POLL_SECONDS ?? TERMIX_RUNTIME_DEFAULT_POLL_SECONDS);
  if (!Number.isInteger(pollSeconds) || pollSeconds < TERMIX_RUNTIME_MIN_POLL_SECONDS) {
    throw new Error(`TERMIX_A2A_POLL_SECONDS must be an integer >= ${TERMIX_RUNTIME_MIN_POLL_SECONDS}`);
  }
  return {
    agentId,
    service: service.data,
    token,
    tokenExpiresAt: env.TERMIX_A2A_RUNTIME_TOKEN_EXPIRES_AT?.trim() || undefined,
    baseUrl: env.TERMIX_AACP_BASE_URL?.trim() || "https://platform-backend.prod.termix.live",
    origin: env.POSITIONCREW_ORIGIN?.trim() || "https://positioncrew.dolepee.com",
    statePath: resolve(
      env.TERMIX_A2A_STATE_PATH?.trim() ||
        `.state/termix-runtime-${service.data.toLowerCase()}.json`,
    ),
    pollSeconds,
    once: argv.includes("--once"),
  };
}

async function loadState(config: RuntimeEnvironment): Promise<TermixRuntimeState> {
  try {
    const state = TermixRuntimeStateSchema.parse(
      JSON.parse(await readFile(config.statePath, "utf8")) as unknown,
    );
    if (state.agentId !== config.agentId || state.service !== config.service) {
      throw new Error("Runtime state belongs to another agent or service");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createTermixRuntimeState(config.agentId, config.service);
  }
}

async function storeState(path: string, state: TermixRuntimeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function log(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export async function runRuntimeCycleWithRecovery(
  config: RuntimeEnvironment,
  state: TermixRuntimeState,
  client: TermixRuntimeTransport = new TermixRuntimeClient(config.token, config.baseUrl),
  now = new Date(),
): Promise<TermixRuntimeState> {
  try {
    return await runRuntimeCycle(config, state, client, now);
  } catch (error) {
    if (error instanceof TermixRuntimeTransportError ||
      (error instanceof TermixRuntimeHttpError && error.status >= 500)) {
      log({ event: "termix.runtime.transient-error",
        ...(error instanceof TermixRuntimeHttpError ? { status: error.status } : { reason: "transport-unavailable" }) });
      // Keep the cursor and deterministic reply keys for the next scheduled poll.
      return state;
    }
    throw error;
  }
}

export async function runRuntimeCycle(
  config: RuntimeEnvironment,
  state: TermixRuntimeState,
  client: TermixRuntimeTransport = new TermixRuntimeClient(config.token, config.baseUrl),
  now = new Date(),
): Promise<TermixRuntimeState> {
  assertRuntimeTokenFresh(config.token, {
    now,
    ...(config.tokenExpiresAt ? { explicitExpiry: config.tokenExpiresAt } : {}),
  });
  const messages = (await client.poll(runtimePollSince(state), 25)).sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.messageId.localeCompare(right.messageId),
  );
  let next = recordTermixRuntimePoll(state, now);
  for (const message of messages) {
    if (hasProcessedRuntimeMessage(next, message.messageId)) continue;
    const decision = buildTermixRuntimeDecision(message, config.service, config.origin);
    if (decision.disposition === "REPLY") {
      await client.signal(message.conversationId).catch(() => undefined);
      await client.reply(message.conversationId, decision.text, decision.clientMessageId);
      log({
        event: "termix.runtime.reply",
        agentId: config.agentId,
        service: config.service,
        messageId: message.messageId,
        conversationKind: message.conversationKind,
      });
    } else if (decision.disposition === "OPERATOR_REQUIRED") {
      log({
        event: "termix.runtime.operator-required",
        agentId: config.agentId,
        service: config.service,
        messageId: message.messageId,
        conversationId: message.conversationId,
        conversationKind: message.conversationKind,
        orderId: message.orderId ?? null,
        disputeId: message.disputeId ?? null,
        reason: decision.reason,
      });
    }
    next = recordTermixRuntimeDecision(next, message, decision, now);
    await storeState(config.statePath, next);
  }
  return next;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--bundle-runtime-artifact") {
    if (argv.length !== 2 || !argv[1]) {
      throw new Error("--bundle-runtime-artifact requires exactly one output path");
    }
    await bundleRuntimeArtifact(argv[1]);
    log({ event: "termix.runtime.bundle-created", outputPath: argv[1] });
    return;
  }
  if (argv[0] === "--validate-runtime-token-file") {
    if (argv.length !== 2 || !argv[1]) {
      throw new Error("--validate-runtime-token-file requires exactly one path");
    }
    validateProtectedRuntimeTokenFile(argv[1], {
      expectedOwnerUserId: 0,
      trustedRoot: "/etc/positioncrew-runtime",
    });
    log({ event: "termix.runtime.credential-source-validated" });
    return;
  }
  if (argv[0] === "--migrate-runtime-state") {
    if (argv.length !== 3 || !argv[1] || !argv[2]) {
      throw new Error("--migrate-runtime-state requires source and target paths");
    }
    const agentId = process.env.TERMIX_A2A_AGENT_ID?.trim();
    const service = ServiceTypeSchema.safeParse(process.env.POSITIONCREW_SERVICE?.trim());
    if (!agentId || !service.success) {
      throw new Error("Runtime state migration requires TERMIX_A2A_AGENT_ID and POSITIONCREW_SERVICE");
    }
    const result = migrateLegacyRuntimeState(argv[1], argv[2], agentId, service.data);
    log({ event: "termix.runtime.state-migration", result });
    return;
  }
  const config = parseRuntimeEnvironment();
  const expiresAt = assertRuntimeTokenFresh(config.token, {
    ...(config.tokenExpiresAt ? { explicitExpiry: config.tokenExpiresAt } : {}),
  });
  let state = await loadState(config);
  await storeState(config.statePath, state);
  log({
    event: "termix.runtime.started",
    agentId: config.agentId,
    service: config.service,
    statePath: config.statePath,
    expiresAt: expiresAt.toISOString(),
    signingMaterialPresent: false,
  });
  while (true) {
    state = await runRuntimeCycleWithRecovery(config, state);
    if (config.once) return;
    await sleep(config.pollSeconds * 1_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: "termix.runtime.stopped",
        error: error instanceof Error ? error.message : "Unknown runtime error",
      })}\n`,
    );
    process.exitCode = runtimeExitCode(error);
  });
}
