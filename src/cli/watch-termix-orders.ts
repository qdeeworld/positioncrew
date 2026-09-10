import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isCliEntrypoint } from "../core/cli-entrypoint.js";
import { z } from "zod";
import { atomicJson } from "../core/atomic-json.js";

export { atomicJson, type AtomicJsonOperations } from "../core/atomic-json.js";

const OrderSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  providerAgentId: z.string().nullish(),
  deliveryDueAt: z.string().datetime().nullish(),
  redoUsed: z.boolean().optional(),
  availableActions: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const OrdersResponseSchema = z.union([
  z.array(OrderSchema),
  z.object({
    items: z.array(OrderSchema),
    page: z.number().int().positive().optional(),
    totalPages: z.number().int().nonnegative().optional(),
  }).passthrough(),
]);

const StateSchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-order-watch.v1"),
  agentId: z.string().min(1),
  observations: z.record(z.string(), z.string()),
  lastPollAt: z.string().datetime().nullable(),
});

type Order = z.infer<typeof OrderSchema>;
type WatchState = z.infer<typeof StateSchema>;

const ACTIONABLE_STATUSES = new Set(["PENDING_ACCEPT", "FUNDED", "IN_PROGRESS"]);

export function normalizeWatchedOrder(input: unknown): Order {
  const order = OrderSchema.parse(input);
  const seller = z.object({id:z.string()}).nullish().parse(order.seller);
  const deadlines = z.object({deliveryDueAt:z.string().datetime().nullish()}).nullish().parse(order.deadlines);
  if (order.providerAgentId && seller?.id && order.providerAgentId !== seller.id) throw new Error("Conflicting provider identity");
  if (order.deliveryDueAt && deadlines?.deliveryDueAt && order.deliveryDueAt !== deadlines.deliveryDueAt) throw new Error("Conflicting delivery deadline");
  return {...order,providerAgentId:order.providerAgentId ?? seller?.id ?? null,deliveryDueAt:order.deliveryDueAt ?? deadlines?.deliveryDueAt ?? null};
}

export function orderFingerprint(input: Order): string {
  const order = normalizeWatchedOrder(input);
  return JSON.stringify({
    status: order.status,
    deliveryDueAt: order.deliveryDueAt ?? null,
    redoUsed: order.redoUsed ?? false,
    canAccept: order.availableActions?.canProviderAccept === true,
    canSubmitDelivery: order.availableActions?.canSubmitDelivery === true,
  });
}

export function actionableOrders(orders: Order[], agentId: string | readonly string[]): Order[] {
  const agentIds = new Set(typeof agentId === "string" ? [agentId] : agentId);
  return orders.map(normalizeWatchedOrder).filter((order) =>
    ACTIONABLE_STATUSES.has(order.status) &&
    (!!order.providerAgentId && agentIds.has(order.providerAgentId))
  );
}

export function unseenOrderTransitions(
  state: WatchState,
  orders: Order[],
): { state: WatchState; changed: Order[] } {
  const observations = { ...state.observations };
  const changed: Order[] = [];
  for (const order of orders) {
    const fingerprint = orderFingerprint(order);
    if (observations[order.id] !== fingerprint) changed.push(order);
    observations[order.id] = fingerprint;
  }
  return {
    state: { ...state, observations, lastPollAt: new Date().toISOString() },
    changed,
  };
}

async function readProtectedToken(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
      throw new Error("TermiX session credential must be a regular file inaccessible to group and others");
    }
    const token = (await handle.readFile("utf8")).trim();
    if (!token || /\s/.test(token)) throw new Error("TermiX session credential is empty or malformed");
    return token;
  } finally {
    await handle.close();
  }
}

async function loadState(path: string, agentId: string): Promise<WatchState> {
  try {
    const state = StateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (state.agentId !== agentId) throw new Error("TermiX order state belongs to another agent");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      schemaVersion: "positioncrew.termix-order-watch.v1",
      agentId,
      observations: {},
      lastPollAt: null,
    };
  }
}

export async function fetchOrders(baseUrl: string, token: string): Promise<Order[]> {
  const orders: Order[] = [];
  const pageSignatures = new Set<string>();
  const pageSize = 50;
  for (let page = 1; page <= 1_000; page += 1) {
    const query = new URLSearchParams({ side: "provider", pageSize: String(pageSize), page: String(page) });
    const response = await fetch(`${baseUrl}/api/v1/orders?${query.toString()}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`TermiX provider-order read failed with HTTP ${response.status}`);
    const parsed = OrdersResponseSchema.parse(await response.json());
    if (Array.isArray(parsed)) {
      orders.push(...parsed.map(normalizeWatchedOrder));
      if (parsed.length < pageSize) return [...new Map(orders.map((order) => [order.id, order])).values()];
      const signature = parsed.map((order) => order.id).join("\n");
      if (pageSignatures.has(signature)) {
        throw new Error("TermiX provider-order endpoint repeated an array page while paginating");
      }
      pageSignatures.add(signature);
      continue;
    }
    orders.push(...parsed.items.map(normalizeWatchedOrder));
    if (parsed.totalPages !== undefined ? page >= parsed.totalPages : parsed.items.length < pageSize) {
      return [...new Map(orders.map((order) => [order.id, order])).values()];
    }
  }
  throw new Error("TermiX provider-order pagination exceeded the 1,000-page safety limit");
}

async function main(): Promise<void> {
  const agentIds = [...new Set(
    (process.env.TERMIX_AGENT_IDS ?? process.env.TERMIX_AGENT_ID ?? "")
      .split(",").map((id) => id.trim()).filter(Boolean),
  )].sort();
  const agentId = agentIds.join(",");
  const tokenPath = process.env.TERMIX_SESSION_TOKEN_FILE?.trim();
  const statePath = resolve(process.env.TERMIX_ORDER_STATE_PATH?.trim() || ".state/termix-orders.json");
  const outboxPath = resolve(process.env.TERMIX_ORDER_OUTBOX_PATH?.trim() || ".state/termix-order-outbox");
  const baseUrl = (process.env.TERMIX_BASE_URL?.trim() || "https://platform-backend.prod.termix.live").replace(/\/$/, "");
  if (!agentId || agentIds.some((id) => !/^[a-z0-9]{20,40}$/.test(id))) {
    throw new Error("TERMIX_AGENT_IDS or TERMIX_AGENT_ID must identify owned agents");
  }
  if (!tokenPath || !tokenPath.startsWith("/")) throw new Error("TERMIX_SESSION_TOKEN_FILE must be absolute");

  const token = await readProtectedToken(tokenPath);
  const previous = await loadState(statePath, agentId);
  const providerOrders = (await fetchOrders(baseUrl, token)).filter(
    (order) => !!order.providerAgentId && agentIds.includes(order.providerAgentId),
  );
  const transition = unseenOrderTransitions(previous, providerOrders);
  const changed = actionableOrders(transition.changed, agentIds);
  if (changed.length) {
    for (const order of changed) {
      const fingerprint = orderFingerprint(order);
      const occurrence = `${transition.state.lastPollAt}\n${randomUUID()}`;
      const id = createHash("sha256").update(`${order.id}\n${fingerprint}\n${occurrence}`).digest("hex");
      await atomicJson(resolve(outboxPath, `${id}.json`), {
        schemaVersion: "positioncrew.termix-order-alert.v1",
        observedAt: transition.state.lastPollAt,
        agentId: order.providerAgentId ?? agentId,
        order: {
          orderId: order.id,
          status: order.status,
          deliveryDueAt: order.deliveryDueAt ?? null,
          availableActions: order.availableActions ?? {},
        },
        boundary: "Operator attention only. No acceptance, delivery, settlement, signing, or transaction was performed.",
      }, 0o640);
    }
  }
  // Persist the deduplication cursor only after the alert outbox is durable.
  // A crash can therefore cause a duplicate alert, but never a lost order.
  await atomicJson(statePath, transition.state);
  process.stdout.write(`${JSON.stringify({
    event: "termix.order-watch.complete",
    agentId,
    actionableCount: actionableOrders(providerOrders, agentIds).length,
    changedCount: changed.length,
    lastPollAt: transition.state.lastPollAt,
  })}\n`);
}

if (isCliEntrypoint(import.meta.url, process.argv[1], "watch-termix-orders")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      event: "termix.order-watch.failed",
      error: error instanceof Error ? error.message : "Unknown order-watch failure",
    })}\n`);
    process.exitCode = 1;
  });
}
