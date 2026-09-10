import { z } from "zod";
import { TimestampSchema, ServiceTypeSchema } from "../contracts/common.js";

export const TERMIX_RUNTIME_TOKEN_LIFETIME_HOURS = 12;
export const TERMIX_RUNTIME_MIN_POLL_SECONDS = 2;
export const TERMIX_RUNTIME_DEFAULT_POLL_SECONDS = 5;
export const TERMIX_RUNTIME_EXPIRY_BUFFER_SECONDS = 5 * 60;

export const TermixConversationKindSchema = z.enum([
  "DIRECT_MESSAGE",
  "ORDER_DELIVERY",
  "QUOTE_NEGOTIATION",
  "PREPAYMENT_ORDER",
  "CHALLENGE",
  "OPERATOR_CASE",
]);

export const TermixRuntimeMessageSchema = z
  .object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    conversationKind: TermixConversationKindSchema,
    orderId: z.string().min(1).nullable().optional(),
    prepaymentOrderId: z.string().min(1).nullable().optional(),
    disputeId: z.string().min(1).nullable().optional(),
    kind: z.string().min(1),
    text: z.string(),
    from: z
      .object({
        accountId: z.string().min(1),
        walletAddress: z.string().min(1),
        displayName: z.string().nullable().optional(),
        handle: z.string().nullable().optional(),
      })
      .passthrough(),
    createdAt: TimestampSchema,
  })
  .passthrough();

export const TermixRuntimeInboxSchema = z
  .object({
    items: z.array(TermixRuntimeMessageSchema),
  })
  .passthrough();

export type TermixRuntimeMessage = z.infer<typeof TermixRuntimeMessageSchema>;
export type PositionCrewService = z.infer<typeof ServiceTypeSchema>;

const RuntimeAttentionSchema = z
  .object({
    messageId: z.string().min(1),
    conversationId: z.string().min(1),
    conversationKind: TermixConversationKindSchema,
    reason: z.string().min(1),
    observedAt: TimestampSchema,
  })
  .strict();

export const TermixRuntimeStateSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.termix-runtime-state.v1"),
    agentId: z.string().min(1),
    service: ServiceTypeSchema,
    cursor: TimestampSchema,
    processedMessageIds: z.array(z.string().min(1)).max(1_000),
    operatorAttention: z.array(RuntimeAttentionSchema).max(100),
    lastPollAt: TimestampSchema.nullable(),
    lastReplyAt: TimestampSchema.nullable(),
    status: z.enum(["READY", "ONLINE", "OPERATOR_ATTENTION", "TOKEN_EXPIRING"]),
  })
  .strict();

export type TermixRuntimeState = z.infer<typeof TermixRuntimeStateSchema>;

export type TermixRuntimeDecision =
  | {
      disposition: "REPLY";
      clientMessageId: string;
      text: string;
      reason: "SERVICE_INQUIRY";
    }
  | {
      disposition: "IGNORE";
      reason: "NON_TEXT_EVENT" | "EMPTY_MESSAGE";
    }
  | {
      disposition: "OPERATOR_REQUIRED";
      reason: "VALUE_BEARING_ORDER" | "DISPUTE_OR_OPERATOR_CASE";
    };

interface ServiceReplyProfile {
  label: string;
  slug: string;
  requiredInputs: string;
  result: string;
}

const SERVICE_REPLY_PROFILES: Record<PositionCrewService, ServiceReplyProfile> = {
  LENDING_RESCUE: {
    label: "Lending Rescue",
    slug: "lending-rescue",
    requiredInputs:
      "a Venus account or position snapshot, target health factor, maximum action value, gas cap, slippage cap, and freshness deadline",
    result:
      "the smallest bounded repay or collateral action that reaches the target, or an explicit refusal",
  },
  LP_REBALANCE: {
    label: "LP Range Operator",
    slug: "lp-rebalance",
    requiredInputs:
      "a PancakeSwap V3 position and pool snapshot, gas and slippage caps, inventory limits, and a freshness deadline",
    result:
      "a cost- and inventory-bounded range shift or HOLD decision",
  },
  YIELD_OPTIMIZATION: {
    label: "Yield Allocator",
    slug: "yield-optimization",
    requiredInputs:
      "the current stablecoin allocation, block-pinned Venus market observations, migration-cost cap, concentration cap, and freshness deadline",
    result:
      "a bounded allocation change or HOLD decision with the migration break-even shown",
  },
  BOUNDED_GRID: {
    label: "Bounded Grid Builder",
    slug: "bounded-grid",
    requiredInputs:
      "a WBNB/USDT market snapshot, capital budget, price bounds, fee and slippage caps, inventory limits, maximum loss, and freshness deadline",
    result:
      "a bounded grid specification or an explicit rejection when the grid is unsafe",
  },
};

function runtimeReply(service: PositionCrewService, origin: string): string {
  const profile = SERVICE_REPLY_PROFILES[service];
  const providerUrl = new URL(`/providers/${profile.slug}`, `${origin}/`).toString();
  const manifestUrl = new URL(`/api/providers/${profile.slug}/manifest`, `${origin}/`).toString();
  return [
    `PositionCrew ${profile.label} is available at a 5 USDC base price with delivery within one day.`,
    `Send ${profile.requiredInputs}.`,
    `The deliverable returns ${profile.result} as machine-readable JSON with source commitments and expiry.`,
    `Try the same provider without a wallet: ${providerUrl}`,
    `Exact machine contract: ${manifestUrl}`,
    "Funded orders are accepted and delivered only after their AACP on-chain state is verified.",
  ].join(" ");
}

export function buildTermixRuntimeDecision(
  message: TermixRuntimeMessage,
  service: PositionCrewService,
  origin = "https://positioncrew.dolepee.com",
): TermixRuntimeDecision {
  if (message.kind !== "TEXT") {
    return { disposition: "IGNORE", reason: "NON_TEXT_EVENT" };
  }
  if (message.text.trim().length === 0) {
    return { disposition: "IGNORE", reason: "EMPTY_MESSAGE" };
  }
  if (
    message.conversationKind === "CHALLENGE" ||
    message.conversationKind === "OPERATOR_CASE"
  ) {
    return { disposition: "OPERATOR_REQUIRED", reason: "DISPUTE_OR_OPERATOR_CASE" };
  }
  if (message.conversationKind === "ORDER_DELIVERY") {
    return { disposition: "OPERATOR_REQUIRED", reason: "VALUE_BEARING_ORDER" };
  }
  return {
    disposition: "REPLY",
    clientMessageId: `positioncrew-${service.toLowerCase()}-${message.messageId}`,
    text: runtimeReply(service, origin),
    reason: "SERVICE_INQUIRY",
  };
}

export function createTermixRuntimeState(
  agentId: string,
  service: PositionCrewService,
  now = new Date(),
): TermixRuntimeState {
  return {
    schemaVersion: "positioncrew.termix-runtime-state.v1",
    agentId,
    service,
    cursor: now.toISOString(),
    processedMessageIds: [],
    operatorAttention: [],
    lastPollAt: null,
    lastReplyAt: null,
    status: "READY",
  };
}

export function hasProcessedRuntimeMessage(
  state: TermixRuntimeState,
  messageId: string,
): boolean {
  return state.processedMessageIds.includes(messageId);
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function recordTermixRuntimeDecision(
  state: TermixRuntimeState,
  message: TermixRuntimeMessage,
  decision: TermixRuntimeDecision,
  now = new Date(),
): TermixRuntimeState {
  const observedAt = now.toISOString();
  const processedMessageIds = [...state.processedMessageIds, message.messageId].slice(-1_000);
  const operatorAttention = decision.disposition === "OPERATOR_REQUIRED"
    ? [
        ...state.operatorAttention,
        {
          messageId: message.messageId,
          conversationId: message.conversationId,
          conversationKind: message.conversationKind,
          reason: decision.reason,
          observedAt,
        },
      ].slice(-100)
    : state.operatorAttention;
  return TermixRuntimeStateSchema.parse({
    ...state,
    cursor: laterTimestamp(state.cursor, message.createdAt),
    processedMessageIds,
    operatorAttention,
    lastPollAt: observedAt,
    lastReplyAt: decision.disposition === "REPLY" ? observedAt : state.lastReplyAt,
    status: operatorAttention.length > 0 ? "OPERATOR_ATTENTION" : "ONLINE",
  });
}

export function runtimePollSince(state: TermixRuntimeState): string {
  return new Date(Math.max(0, Date.parse(state.cursor) - 1_000)).toISOString();
}

export function recordTermixRuntimePoll(
  state: TermixRuntimeState,
  now = new Date(),
): TermixRuntimeState {
  return TermixRuntimeStateSchema.parse({
    ...state,
    lastPollAt: now.toISOString(),
    status: state.operatorAttention.length > 0 ? "OPERATOR_ATTENTION" : "ONLINE",
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as unknown;
    return typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function resolveRuntimeTokenExpiry(
  token: string,
  explicitExpiry?: string,
): Date | null {
  if (explicitExpiry) {
    const parsed = Date.parse(explicitExpiry);
    if (!Number.isFinite(parsed)) {
      throw new TermixRuntimeTokenError("TERMIX_A2A_RUNTIME_TOKEN_EXPIRES_AT is invalid");
    }
    return new Date(parsed);
  }
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1_000) : null;
}

export function assertRuntimeTokenFresh(
  token: string,
  options: {
    explicitExpiry?: string;
    now?: Date;
    minimumRemainingSeconds?: number;
  } = {},
): Date {
  if (token.trim().length < 16) {
    throw new TermixRuntimeTokenError("TERMIX_A2A_RUNTIME_TOKEN is missing or malformed");
  }
  const expiresAt = resolveRuntimeTokenExpiry(token, options.explicitExpiry);
  if (!expiresAt) {
    throw new TermixRuntimeTokenError(
      "Runtime token expiry is unknown; provide TERMIX_A2A_RUNTIME_TOKEN_EXPIRES_AT",
    );
  }
  const now = options.now ?? new Date();
  const minimumRemainingSeconds =
    options.minimumRemainingSeconds ?? TERMIX_RUNTIME_EXPIRY_BUFFER_SECONDS;
  if (expiresAt.getTime() - now.getTime() <= minimumRemainingSeconds * 1_000) {
    throw new TermixRuntimeTokenError(
      "TermiX runtime token is expired or inside the fail-closed refresh window",
    );
  }
  return expiresAt;
}

export class TermixRuntimeTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TermixRuntimeTokenError";
  }
}

export class TermixRuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    super(`TermiX runtime ${method} ${path} returned HTTP ${status}`);
    this.name = "TermixRuntimeHttpError";
  }
}

export interface TermixRuntimeTransport {
  poll(since: string, limit?: number): Promise<TermixRuntimeMessage[]>;
  signal(conversationId: string): Promise<void>;
  reply(conversationId: string, text: string, clientMessageId: string): Promise<void>;
}

export class TermixRuntimeTransportError extends Error {
  constructor() {
    // Do not retain fetch diagnostics, which may include request credentials.
    super("TermiX runtime transport unavailable");
    this.name = "TermixRuntimeTransportError";
  }
}

export class TermixRuntimeClient implements TermixRuntimeTransport {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://platform-backend.prod.termix.live",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const url = new URL(path, `${this.baseUrl}/`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      throw new TermixRuntimeTransportError();
    }
    if (!response.ok) throw new TermixRuntimeHttpError(response.status, method, path);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new TermixRuntimeTransportError();
    }
    return JSON.parse(text) as unknown;
  }

  async poll(since: string, limit = 25): Promise<TermixRuntimeMessage[]> {
    const params = new URLSearchParams({ since, limit: String(Math.min(100, Math.max(1, limit))) });
    const payload = await this.request("GET", `/api/v1/a2a/runtime/inbox?${params.toString()}`);
    return TermixRuntimeInboxSchema.parse(payload).items;
  }

  async signal(conversationId: string): Promise<void> {
    await this.request("POST", "/api/v1/a2a/runtime/signal", {
      conversationId,
      state: "thinking",
    });
  }

  async reply(
    conversationId: string,
    text: string,
    clientMessageId: string,
  ): Promise<void> {
    await this.request("POST", "/api/v1/a2a/runtime/reply", {
      conversationId,
      text,
      clientMessageId,
    });
  }
}
