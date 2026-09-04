import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

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

type AtomicJsonHandle = {
  writeFile?: (data: string, options: { encoding: "utf8" }) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

export type AtomicJsonOperations = {
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<void>;
  open: (path: string, flags: number, mode?: number) => Promise<AtomicJsonHandle>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
};

const DEFAULT_ATOMIC_JSON_OPERATIONS: AtomicJsonOperations = {
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  open,
  rename,
  unlink,
};

const ACTIONABLE_STATUSES = new Set(["PENDING_ACCEPT", "FUNDED", "IN_PROGRESS"]);

export function orderFingerprint(order: Order): string {
  return JSON.stringify({
    status: order.status,
    deliveryDueAt: order.deliveryDueAt ?? null,
    redoUsed: order.redoUsed ?? false,
    canAccept: order.availableActions?.canProviderAccept === true,
    canSubmitDelivery: order.availableActions?.canSubmitDelivery === true,
  });
}

export function actionableOrders(orders: Order[], agentId: string): Order[] {
  return orders.filter((order) =>
    ACTIONABLE_STATUSES.has(order.status) &&
    (!order.providerAgentId || order.providerAgentId === agentId)
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

export async function atomicJson(
  path: string,
  value: unknown,
  mode = 0o600,
  operations: AtomicJsonOperations = DEFAULT_ATOMIC_JSON_OPERATIONS,
): Promise<void> {
  const directory = dirname(path);
  await operations.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  let renamed = false;
  try {
    const temporaryHandle = await operations.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    try {
      if (!temporaryHandle.writeFile) throw new Error("Atomic JSON temporary file is not writable");
      await temporaryHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }

    await operations.rename(temporary, path);
    renamed = true;

    const directoryHandle = await operations.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (!renamed) {
      try {
        await operations.unlink(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  }
}

async function fetchOrders(baseUrl: string, token: string): Promise<Order[]> {
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
      orders.push(...parsed);
      if (parsed.length < pageSize) return [...new Map(orders.map((order) => [order.id, order])).values()];
      const signature = parsed.map((order) => order.id).join("\n");
      if (pageSignatures.has(signature)) {
        throw new Error("TermiX provider-order endpoint repeated an array page while paginating");
      }
      pageSignatures.add(signature);
      continue;
    }
    orders.push(...parsed.items);
    if (parsed.totalPages !== undefined ? page >= parsed.totalPages : parsed.items.length < pageSize) {
      return [...new Map(orders.map((order) => [order.id, order])).values()];
    }
  }
  throw new Error("TermiX provider-order pagination exceeded the 1,000-page safety limit");
}

async function main(): Promise<void> {
  const agentId = process.env.TERMIX_AGENT_ID?.trim();
  const tokenPath = process.env.TERMIX_SESSION_TOKEN_FILE?.trim();
  const statePath = resolve(process.env.TERMIX_ORDER_STATE_PATH?.trim() || ".state/termix-orders.json");
  const outboxPath = resolve(process.env.TERMIX_ORDER_OUTBOX_PATH?.trim() || ".state/termix-order-outbox");
  const baseUrl = (process.env.TERMIX_BASE_URL?.trim() || "https://platform-backend.prod.termix.live").replace(/\/$/, "");
  if (!agentId) throw new Error("TERMIX_AGENT_ID is required");
  if (!tokenPath || !tokenPath.startsWith("/")) throw new Error("TERMIX_SESSION_TOKEN_FILE must be absolute");

  const token = await readProtectedToken(tokenPath);
  const previous = await loadState(statePath, agentId);
  const providerOrders = (await fetchOrders(baseUrl, token)).filter(
    (order) => !order.providerAgentId || order.providerAgentId === agentId,
  );
  const transition = unseenOrderTransitions(previous, providerOrders);
  const changed = actionableOrders(transition.changed, agentId);
  if (changed.length) {
    for (const order of changed) {
      const fingerprint = orderFingerprint(order);
      const occurrence = `${transition.state.lastPollAt}\n${randomUUID()}`;
      const id = createHash("sha256").update(`${order.id}\n${fingerprint}\n${occurrence}`).digest("hex");
      await atomicJson(resolve(outboxPath, `${id}.json`), {
        schemaVersion: "positioncrew.termix-order-alert.v1",
        observedAt: transition.state.lastPollAt,
        agentId,
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
    actionableCount: actionableOrders(providerOrders, agentId).length,
    changedCount: changed.length,
    lastPollAt: transition.state.lastPollAt,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      event: "termix.order-watch.failed",
      error: error instanceof Error ? error.message : "Unknown order-watch failure",
    })}\n`);
    process.exitCode = 1;
  });
}
