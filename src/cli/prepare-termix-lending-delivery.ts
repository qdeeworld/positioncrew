import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalHash } from "../core/canonical.js";
import {
  assertTermixProviderIntent,
  assertTermixProviderOrder,
  createTermixLendingDeliveryArtifact,
  sealTermixFulfillmentCheckpoint,
  termixDeliveryArtifactDescriptor,
  TermixContractsConfigSchema,
  TermixFulfillmentCheckpointSchema,
  TermixLendingDeliveryArtifactSchema,
  TermixLendingIntakeSchema,
  TermixProviderOrderSchema,
  verifyTermixFulfillmentCheckpoint,
  type TermixFulfillmentCheckpoint,
  type TermixProviderOrder,
} from "../commerce/termix-provider-delivery.js";
import { inspectVenusAccount } from "../telemetry/bsc.js";
import { atomicJson } from "./watch-termix-orders.js";

const BASE_URL = "https://platform-backend.prod.termix.live";
const MAX_JSON_BYTES = 1_048_576;

const UploadGrantSchema = z.object({
  uploadUrl: z.string().url(),
  s3Key: z.string().min(1),
  publicUrl: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
}).passthrough();

const RemoteArtifactSchema = z.object({
  id: z.string().min(1),
  sha256: z.string().regex(/^(?:(?:sha256:)|(?:0x))?[a-fA-F0-9]{64}$/),
  url: z.string().url().optional(),
  publicUrl: z.string().url().optional(),
}).passthrough();

type Command = "observe" | "prepare-accept" | "prepare-delivery" | "status" | "intake-template";

function usage(): never {
  throw new Error(
    "Usage: prepare-termix-lending-delivery <observe|prepare-accept|prepare-delivery|status|intake-template> --order <id> [--intake <absolute-json-path>] [--refresh-expired]",
  );
}

function parseArguments(argv: string[]): { command: Command; orderId: string; intakePath?: string; refreshExpired: boolean } {
  const command = argv[0] as Command;
  if (!["observe", "prepare-accept", "prepare-delivery", "status", "intake-template"].includes(command)) usage();
  let orderId: string | undefined;
  let intakePath: string | undefined;
  let refreshExpired = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--refresh-expired") {
      if (refreshExpired) usage();
      refreshExpired = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    if (flag === "--order" && !orderId) orderId = value;
    else if (flag === "--intake" && !intakePath) intakePath = value;
    else usage();
    index += 1;
  }
  if (!orderId || !/^[a-zA-Z0-9_-]{1,200}$/.test(orderId)) {
    throw new Error("--order must be a safe TermiX order identifier");
  }
  if (command === "prepare-delivery" && (!intakePath || !isAbsolute(intakePath))) {
    throw new Error("prepare-delivery requires --intake with an absolute JSON path");
  }
  if (refreshExpired && command !== "prepare-delivery") {
    throw new Error("--refresh-expired is valid only with prepare-delivery");
  }
  return { command, orderId, ...(intakePath ? { intakePath } : {}), refreshExpired };
}

function checkedBaseUrl(): string {
  const value = (process.env.TERMIX_BASE_URL?.trim() || BASE_URL).replace(/\/$/, "");
  const url = new URL(value);
  if (url.origin !== BASE_URL || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`TERMIX_BASE_URL must be exactly ${BASE_URL}`);
  }
  return value;
}

async function readBoundedFile(path: string, confidential: boolean): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_JSON_BYTES) {
      throw new Error(`${path} must be a non-empty regular file smaller than 1 MiB`);
    }
    if (confidential ? (stats.mode & 0o077) !== 0 : (stats.mode & 0o022) !== 0) {
      throw new Error(confidential
        ? `${path} must be inaccessible to group and others`
        : `${path} must not be writable by group or others`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readSessionToken(): Promise<string> {
  const path = process.env.TERMIX_SESSION_TOKEN_FILE?.trim();
  if (!path || !isAbsolute(path)) throw new Error("TERMIX_SESSION_TOKEN_FILE must be absolute");
  const token = (await readBoundedFile(path, true)).trim();
  if (!token || /\s/.test(token)) throw new Error("TermiX session token is malformed");
  return token;
}

async function decodeJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > MAX_JSON_BYTES) throw new Error("TermiX response exceeds the 1 MiB limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("TermiX response exceeds the 1 MiB limit");
  const text = new TextDecoder().decode(bytes);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`TermiX returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message = typeof body === "object" && body && "message" in body
      ? String((body as { message: unknown }).message)
      : `HTTP ${response.status}`;
    throw new Error(`TermiX request failed: ${message.slice(0, 500)}`);
  }
  return body;
}

async function apiJson(
  baseUrl: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = new URL(path, `${baseUrl}/`);
  if (url.origin !== baseUrl) throw new Error("TermiX API path escaped the configured origin");
  const response = await fetch(url, {
    method,
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return decodeJson(response);
}

async function publicJson(baseUrl: string, path: string): Promise<unknown> {
  const url = new URL(path, `${baseUrl}/`);
  if (url.origin !== baseUrl) throw new Error("TermiX public API path escaped the configured origin");
  return decodeJson(await fetch(url, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }));
}

function identity(): { providerAgentId: string; listingId: string } {
  const providerAgentId = process.env.TERMIX_AGENT_ID?.trim();
  const listingId = process.env.TERMIX_LISTING_ID?.trim();
  if (!providerAgentId || !listingId) {
    throw new Error("TERMIX_AGENT_ID and TERMIX_LISTING_ID are required");
  }
  return { providerAgentId, listingId };
}

function statePaths(orderId: string): { root: string; checkpoint: string; artifactRoot: string } {
  const root = resolve(process.env.TERMIX_FULFILLMENT_STATE_DIR?.trim() || "/var/lib/positioncrew-termix-orders/fulfillment");
  if (!isAbsolute(root)) throw new Error("TERMIX_FULFILLMENT_STATE_DIR must be absolute");
  const key = canonicalHash(orderId).slice("sha256:".length);
  return {
    root,
    checkpoint: resolve(root, `${key}.json`),
    artifactRoot: resolve(root, "artifacts"),
  };
}

async function loadCheckpoint(path: string): Promise<TermixFulfillmentCheckpoint | null> {
  try {
    return verifyTermixFulfillmentCheckpoint(JSON.parse(await readBoundedFile(path, true)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function checkpointDraft(
  baseUrl: string,
  order: TermixProviderOrder,
  stage: z.infer<typeof TermixFulfillmentCheckpointSchema>["stage"],
  previous: TermixFulfillmentCheckpoint | null,
  now: Date,
): Omit<TermixFulfillmentCheckpoint, "checkpointHash"> {
  const round = order.redoUsed ? 2 : 1;
  const retain = previous?.orderId === order.id && previous.deliveryRound === round;
  return {
    schemaVersion: "positioncrew.termix-lending-fulfillment.v1",
    chainId: 56,
    baseUrl,
    providerAgentId: order.providerAgentId,
    listingId: order.listingId,
    orderId: order.id,
    deliveryRound: round,
    stage,
    order,
    orderHash: canonicalHash(order),
    intake: retain ? previous.intake : null,
    intakeHash: retain ? previous.intakeHash : null,
    artifact: retain ? previous.artifact : null,
    acceptIntent: retain ? previous.acceptIntent : null,
    acceptIntentHash: retain ? previous.acceptIntentHash : null,
    submitIntent: retain ? previous.submitIntent : null,
    submitIntentHash: retain ? previous.submitIntentHash : null,
    preparedAt: retain ? previous.preparedAt : now.toISOString(),
    updatedAt: now.toISOString(),
    boundaries: {
      acceptanceBroadcast: false,
      deliveryBroadcast: false,
      walletSignatureCreated: false,
      settlementCompleted: false,
    },
  };
}

async function saveCheckpoint(path: string, draft: Omit<TermixFulfillmentCheckpoint, "checkpointHash">): Promise<TermixFulfillmentCheckpoint> {
  const checkpoint = sealTermixFulfillmentCheckpoint(draft);
  await atomicJson(path, checkpoint);
  return checkpoint;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeSha256(value: string): string {
  return value.replace(/^(?:sha256:|0x)/i, "").toLowerCase();
}

function remoteArtifacts(input: unknown): z.infer<typeof RemoteArtifactSchema>[] {
  const items = Array.isArray(input)
    ? input
    : typeof input === "object" && input && "items" in input && Array.isArray((input as { items: unknown }).items)
      ? (input as { items: unknown[] }).items
      : typeof input === "object" && input && "artifacts" in input && Array.isArray((input as { artifacts: unknown }).artifacts)
        ? (input as { artifacts: unknown[] }).artifacts
        : null;
  if (!items) throw new Error("TermiX artifact list has an undocumented response shape");
  return z.array(RemoteArtifactSchema).parse(items);
}

function registeredArtifact(input: unknown): z.infer<typeof RemoteArtifactSchema> {
  const candidates = [
    input,
    typeof input === "object" && input && "artifact" in input ? (input as { artifact: unknown }).artifact : null,
    typeof input === "object" && input && "data" in input ? (input as { data: unknown }).data : null,
  ];
  for (const candidate of candidates) {
    const parsed = RemoteArtifactSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  throw new Error("TermiX artifact registration has an undocumented response shape");
}

async function uploadArtifact(grantInput: unknown, content: string, contentType: string): Promise<void> {
  const grant = UploadGrantSchema.parse(grantInput);
  const uploadUrl = new URL(grant.uploadUrl);
  if (uploadUrl.protocol !== "https:" || !uploadUrl.hostname.endsWith(".amazonaws.com")) {
    throw new Error("TermiX upload grant did not target an allowed HTTPS S3 host");
  }
  const response = await fetch(uploadUrl, {
    method: "PUT",
    redirect: "error",
    headers: { ...grant.headers, "content-type": contentType },
    body: content,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`TermiX artifact upload failed with HTTP ${response.status}`);
}

async function verifyPublishedArtifact(
  urlValue: string,
  expected: { sha256: string; sizeBytes: number },
): Promise<void> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".amazonaws.com")) {
    throw new Error("Registered TermiX artifact did not use an allowed HTTPS S3 host");
  }
  const response = await fetch(url, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Registered TermiX artifact read failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared && declared !== expected.sizeBytes) {
    throw new Error("Registered TermiX artifact has an unexpected Content-Length");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expected.sizeBytes) {
    throw new Error("Registered TermiX artifact byte length differs from the reviewed artifact");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.sha256) {
    throw new Error("Registered TermiX artifact bytes differ from the reviewed artifact hash");
  }
}

async function fetchOrder(baseUrl: string, token: string, orderId: string): Promise<TermixProviderOrder> {
  const expected = identity();
  return assertTermixProviderOrder(
    await apiJson(baseUrl, token, "GET", `/api/v1/orders/${encodeURIComponent(orderId)}`),
    { orderId, ...expected },
  );
}

function stageForObservation(order: TermixProviderOrder): z.infer<typeof TermixFulfillmentCheckpointSchema>["stage"] {
  if (order.status === "DELIVERED" || order.status === "ACCEPTED" || order.status === "SETTLED") return "DELIVERED";
  if (order.deliveryDueAt && Date.parse(order.deliveryDueAt) <= Date.now()) return "EXPIRED";
  if (["FUNDED", "IN_PROGRESS"].includes(order.status)) return "NEEDS_BUYER_INPUT";
  return "ORDER_OBSERVED";
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const paths = statePaths(args.orderId);
  if (args.command === "intake-template") {
    const capturedAt = new Date().toISOString();
    print({
      schemaVersion: "positioncrew.termix-lending-intake.v1",
      orderId: args.orderId,
      account: "0x0000000000000000000000000000000000000000",
      targetHealthFactor: "1.25",
      stressPriceDropBps: 1000,
      maxActionUsd: "250",
      maxGasUsd: "0.10",
      maxSlippageBps: 30,
      buyerEvidence: {
        kind: "TERMIX_BUYER_MESSAGE",
        reference: "replace-with-conversation-or-attachment-id",
        exactInstruction: "Replace this text with the buyer's exact instruction containing 0x0000000000000000000000000000000000000000.",
        capturedAt,
        declaredConstraints: {
          account: "0x0000000000000000000000000000000000000000",
          targetHealthFactor: "1.25",
          stressPriceDropBps: 1000,
          maxActionUsd: "250",
          maxGasUsd: "0.10",
          maxSlippageBps: 30,
        },
      },
    });
    return;
  }
  if (args.command === "status") {
    const checkpoint = await loadCheckpoint(paths.checkpoint);
    print(checkpoint ?? { status: "NO_CHECKPOINT", orderId: args.orderId });
    return;
  }

  const baseUrl = checkedBaseUrl();
  const token = await readSessionToken();
  const order = await fetchOrder(baseUrl, token, args.orderId);
  const previous = await loadCheckpoint(paths.checkpoint);
  if (previous && (
    previous.baseUrl !== baseUrl ||
    previous.providerAgentId !== order.providerAgentId ||
    previous.listingId !== order.listingId
  )) throw new Error("Existing fulfillment checkpoint has a different immutable identity");

  if (args.command === "observe") {
    const checkpoint = await saveCheckpoint(
      paths.checkpoint,
      checkpointDraft(baseUrl, order, stageForObservation(order), previous, new Date()),
    );
    print(checkpoint);
    return;
  }

  const config = TermixContractsConfigSchema.parse(
    await publicJson(baseUrl, "/api/v1/config/contracts"),
  );
  if (args.command === "prepare-accept") {
    if (previous?.acceptIntent && previous.deliveryRound === (order.redoUsed ? 2 : 1)) {
      const guarded = assertTermixProviderIntent(
        order,
        config,
        previous.acceptIntent,
        "acceptOrder",
        { now: new Date() },
      );
      if (guarded.intentHash !== previous.acceptIntentHash) {
        throw new Error("Cached acceptance intent hash differs from the protected checkpoint");
      }
      const draft = checkpointDraft(baseUrl, order, "ACCEPT_INTENT_PREPARED", previous, new Date());
      const checkpoint = await saveCheckpoint(paths.checkpoint, draft);
      print({
        ...checkpoint,
        nextAction: "Explicit operator confirmation is required before broadcasting acceptOrder.",
      });
      return;
    }
    const prepared = await apiJson(
      baseUrl,
      token,
      "POST",
      `/api/v1/orders/${encodeURIComponent(order.id)}/provider-accept/prepare`,
      {},
    );
    const guarded = assertTermixProviderIntent(order, config, prepared, "acceptOrder");
    const draft = checkpointDraft(baseUrl, order, "ACCEPT_INTENT_PREPARED", previous, new Date());
    draft.acceptIntent = guarded.intent;
    draft.acceptIntentHash = guarded.intentHash;
    const checkpoint = await saveCheckpoint(paths.checkpoint, draft);
    print({
      ...checkpoint,
      nextAction: "Explicit operator confirmation is required before broadcasting acceptOrder.",
    });
    return;
  }

  const intake = TermixLendingIntakeSchema.parse(
    JSON.parse(await readBoundedFile(args.intakePath!, false)),
  );
  if (intake.orderId !== order.id) throw new Error("Intake orderId does not match --order");
  if (!["FUNDED", "IN_PROGRESS"].includes(order.status) || order.availableActions.canSubmitDelivery !== true) {
    throw new Error("Order is not indexed as ready for delivery");
  }
  if (!order.deliveryDueAt || Date.parse(order.deliveryDueAt) - Date.now() < 120_000) {
    throw new Error("Order delivery deadline has less than 120 seconds remaining");
  }
  const intakeHash = canonicalHash(intake);
  const sameRound = previous?.deliveryRound === (order.redoUsed ? 2 : 1);
  if (sameRound && previous.intakeHash && previous.intakeHash !== intakeHash) {
    throw new Error("Current-round buyer constraints differ from the protected checkpoint");
  }
  const priorArtifact = sameRound ? previous?.artifact ?? null : null;
  const existingExpired = priorArtifact
    ? Date.parse(priorArtifact.resultExpiresAt) - Date.now() < 120_000
    : false;
  if (args.refreshExpired && (!priorArtifact || !existingExpired)) {
    throw new Error("--refresh-expired requires an existing current-round artifact with less than 120 seconds remaining");
  }

  let artifact;
  let descriptor;
  if (priorArtifact && !args.refreshExpired) {
    if (existingExpired) {
      throw new Error("Prepared artifact is expired; rerun explicitly with --refresh-expired");
    }
    const artifactPath = resolve(priorArtifact.localPath);
    if (!artifactPath.startsWith(`${paths.artifactRoot}/`)) {
      throw new Error("Checkpoint artifact path escapes the protected artifact directory");
    }
    const storedContent = await readBoundedFile(artifactPath, true);
    artifact = TermixLendingDeliveryArtifactSchema.parse(JSON.parse(storedContent));
    descriptor = termixDeliveryArtifactDescriptor(artifact);
    if (
      storedContent !== descriptor.content ||
      descriptor.sha256 !== priorArtifact.sha256 ||
      descriptor.deliveryHash.toLowerCase() !== priorArtifact.deliveryHash.toLowerCase() ||
      descriptor.sizeBytes !== priorArtifact.sizeBytes
    ) throw new Error("Current-round artifact differs from the protected checkpoint");
  } else {
    const probe = await inspectVenusAccount(intake.account, {
      targetHealthFactor: intake.targetHealthFactor,
      stressPriceDropBps: intake.stressPriceDropBps,
      maxActionUsd: intake.maxActionUsd,
      maxGasUsd: intake.maxGasUsd,
      maxSlippageBps: intake.maxSlippageBps,
    });
    const now = new Date();
    if (Date.parse(order.deliveryDueAt) - now.getTime() < 120_000) {
      throw new Error("Order deadline became unsafe while collecting the Venus observation");
    }
    artifact = createTermixLendingDeliveryArtifact(order, intake, probe, now);
    descriptor = termixDeliveryArtifactDescriptor(artifact);
  }
  const now = new Date();
  await mkdir(paths.artifactRoot, { recursive: true, mode: 0o700 });
  const artifactPath = resolve(paths.artifactRoot, descriptor.fileName);
  await atomicJson(artifactPath, artifact);

  let draft = checkpointDraft(baseUrl, order, "DELIVERABLE_PREPARED", previous, now);
  draft.intake = intake;
  draft.intakeHash = intakeHash;
  draft.artifact = {
    fileName: descriptor.fileName,
    contentType: descriptor.contentType,
    sizeBytes: descriptor.sizeBytes,
    sha256: descriptor.sha256,
    deliveryHash: descriptor.deliveryHash,
    localPath: artifactPath,
    remoteArtifactId: priorArtifact && !args.refreshExpired ? priorArtifact.remoteArtifactId : null,
    publicUrl: priorArtifact && !args.refreshExpired ? priorArtifact.publicUrl : null,
    resultExpiresAt: artifact.result.expiresAt,
  };
  if (args.refreshExpired) {
    draft.submitIntent = null;
    draft.submitIntentHash = null;
  }
  await saveCheckpoint(paths.checkpoint, draft);

  if (previous?.submitIntent && previous.submitIntentHash && priorArtifact && !args.refreshExpired) {
    if (Date.parse(priorArtifact.resultExpiresAt) - Date.now() < 120_000) {
      throw new Error("Cached delivery artifact has less than 120 seconds remaining");
    }
    if (!priorArtifact.publicUrl) {
      throw new Error("Cached delivery artifact has no public verification URL");
    }
    await verifyPublishedArtifact(priorArtifact.publicUrl, descriptor);
    if (Date.parse(priorArtifact.resultExpiresAt) - Date.now() < 120_000) {
      throw new Error("Cached delivery artifact became unsafe during remote verification");
    }
    const guarded = assertTermixProviderIntent(order, config, previous.submitIntent, "submitDelivery", {
      expectedDeliveryHash: descriptor.deliveryHash,
      now: new Date(),
    });
    if (guarded.intentHash !== previous.submitIntentHash) {
      throw new Error("Cached delivery intent hash differs from the protected checkpoint");
    }
    draft = checkpointDraft(baseUrl, order, "SUBMIT_INTENT_PREPARED", await loadCheckpoint(paths.checkpoint), new Date());
    const checkpoint = await saveCheckpoint(paths.checkpoint, draft);
    print({
      ...checkpoint,
      nextAction: "Explicit operator confirmation is required before broadcasting submitDelivery.",
    });
    return;
  }

  const artifactPathname = `/api/v1/orders/${encodeURIComponent(order.id)}/delivery/artifacts`;
  const listed = remoteArtifacts(await apiJson(baseUrl, token, "GET", artifactPathname));
  let registered = listed.find((item) => normalizeSha256(item.sha256) === descriptor.sha256);
  if (!registered) {
    const grantRaw = await apiJson(
      baseUrl,
      token,
      "POST",
      `/api/v1/orders/${encodeURIComponent(order.id)}/delivery/upload-url`,
      {
        fileName: descriptor.fileName,
        contentType: descriptor.contentType,
        sizeBytes: descriptor.sizeBytes,
      },
    );
    const grant = UploadGrantSchema.parse(grantRaw);
    await uploadArtifact(grant, descriptor.content, descriptor.contentType);
    registered = registeredArtifact(await apiJson(baseUrl, token, "POST", artifactPathname, {
      s3Key: grant.s3Key,
      url: grant.publicUrl,
      sha256: `0x${descriptor.sha256}`,
      contentType: descriptor.contentType,
      sizeBytes: descriptor.sizeBytes,
    }));
  }
  if (normalizeSha256(registered.sha256) !== descriptor.sha256) {
    throw new Error("Registered TermiX artifact hash differs from the local deliverable");
  }
  const publicUrl = registered.publicUrl ?? registered.url;
  if (!publicUrl) throw new Error("Registered TermiX artifact has no public verification URL");
  await verifyPublishedArtifact(publicUrl, descriptor);

  draft = checkpointDraft(baseUrl, order, "ARTIFACT_REGISTERED", await loadCheckpoint(paths.checkpoint), new Date());
  if (!draft.artifact) throw new Error("Prepared artifact disappeared from the checkpoint");
  draft.artifact.remoteArtifactId = registered.id;
  draft.artifact.publicUrl = publicUrl;
  await saveCheckpoint(paths.checkpoint, draft);

  if (Date.parse(artifact.result.expiresAt) - Date.now() < 120_000) {
    throw new Error("Delivery artifact has less than 120 seconds remaining before submit preparation");
  }
  const submitRaw = await apiJson(
    baseUrl,
    token,
    "POST",
    `/api/v1/orders/${encodeURIComponent(order.id)}/delivery/submit`,
    {
      deliveryHash: descriptor.deliveryHash,
      note: "PositionCrew bounded Lending Rescue analysis and conformance receipt.",
    },
  );
  if (Date.parse(artifact.result.expiresAt) - Date.now() < 120_000) {
    throw new Error("Delivery artifact became unsafe while preparing the submit intent");
  }
  const guarded = assertTermixProviderIntent(order, config, submitRaw, "submitDelivery", {
    expectedDeliveryHash: descriptor.deliveryHash,
    now: new Date(),
  });
  draft = checkpointDraft(baseUrl, order, "SUBMIT_INTENT_PREPARED", await loadCheckpoint(paths.checkpoint), new Date());
  draft.submitIntent = guarded.intent;
  draft.submitIntentHash = guarded.intentHash;
  const checkpoint = await saveCheckpoint(paths.checkpoint, draft);
  print({
    ...checkpoint,
    nextAction: "Explicit operator confirmation is required before broadcasting submitDelivery.",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      event: "termix.lending-fulfillment.failed",
      error: error instanceof Error ? error.message : "Unknown TermiX fulfillment failure",
      boundary: "No wallet signature or transaction broadcast was attempted.",
    })}\n`);
    process.exitCode = 1;
  });
}
