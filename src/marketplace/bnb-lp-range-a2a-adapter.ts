import { verifyMessage } from "ethers";
import { z } from "zod";

import {
  LpRebalanceRequestSchema,
  type LpRebalanceRequest,
} from "../contracts/lp-rebalance.js";
import { canonicalHash } from "../core/canonical.js";

const BNB_LP_RANGE_PROVIDER = {
  agentTokenId: 265375,
  endpoint: "https://bnb-lp.172-104-171-139.nip.io/",
  registryOwner: "0x20f1cA5d1e5A3Ee94C29DbF95e6BF6ceA6a8d64b",
  kernel: "0xEa4DAa3100A767e86FDed867729ae7446476EBA6",
  paymentToken: "0xcE24439F2D9C6a2289F741120FE202248B666666",
  maximumPriceAtomic: "100000000000000000",
} as const;

const quoteTerms = {
  deliverables:
    "Return a machine-readable LP range recommendation or HOLD/refusal attributable to this exact requestId, including source block, proposed ticks, expected costs, expiry, and reasons.",
  quality_standards:
    "Bind to the exact requestId and BSC block; do not claim execution; preserve buyer maxActionUsd, maxGasUsd, maxSlippageBps, deadline, and all constraints; refuse if data is stale or unsupported.",
} as const;

const QuoteDataSchema = z
  .object({
    request: z
      .object({
        task_description: z.string().min(1),
        terms: z
          .object({
            deliverables: z.string().min(1),
            quality_standards: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
    request_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    response: z
      .object({
        accepted: z.literal(true),
        terms: z
          .object({
            deliverables: z.string().min(1),
            quality_standards: z.string().min(1),
            price: z.string().regex(/^\d+$/),
            currency: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          })
          .passthrough(),
        estimated_completion_seconds: z.number().int().positive(),
        quote_expires_at: z.number().int().positive(),
        negotiated_at: z.number().int().positive(),
      })
      .passthrough(),
    response_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    negotiation_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    provider_sig: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
    chain_id: z.literal(56),
    verifying_contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  })
  .passthrough();

const QuoteEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: z
      .object({
        kind: z.literal("message"),
        messageId: z.string().min(1),
        parts: z
          .array(
            z
              .object({
                kind: z.literal("data"),
                data: QuoteDataSchema,
              })
              .passthrough(),
          )
          .min(1),
      })
      .passthrough(),
  })
  .strict();

export type BnbLpSignedQuote = z.infer<typeof QuoteDataSchema>;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function taskDescription(request: LpRebalanceRequest): string {
  return `Evaluate this exact PositionCrew LP_REBALANCE request without changing its fields: ${JSON.stringify(request)}`;
}

export function buildBnbLpRangeQuoteRequest(
  input: LpRebalanceRequest,
  messageId = crypto.randomUUID(),
): Record<string, unknown> {
  const request = LpRebalanceRequestSchema.parse(input);
  return {
    jsonrpc: "2.0",
    id: messageId,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId,
        parts: [
          {
            kind: "data",
            data: {
              skill: "negotiate",
              task_description: taskDescription(request),
              terms: quoteTerms,
            },
          },
        ],
      },
    },
  };
}

async function readBoundedJson(
  response: Response,
  maximumBytes = 128 * 1024,
): Promise<unknown> {
  if (!response.body) throw new Error("External LP quote response has no body");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`External LP quote exceeds ${maximumBytes} bytes`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel("response exceeds PositionCrew limit").catch(() => undefined);
      throw new Error(`External LP quote exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

export interface BnbLpRangeQuoteTrace {
  schemaVersion: "positioncrew.live-match.lp-quote-trace.v1";
  adapterId: "positioncrew:a2a:bnb-lp-range:quote:v1";
  providerAgentTokenId: 265375;
  endpoint: string;
  frozenRequest: LpRebalanceRequest;
  frozenRequestHash: string;
  nativeRequest: Record<string, unknown>;
  nativeRequestHash: string;
  startedAt: string;
  completedAt: string;
  durationMilliseconds: number;
  quote: BnbLpSignedQuote;
  recoveredSigner: string;
  states: {
    identity: "FROZEN_REGISTRY_OWNER_SIGNATURE_MATCHED";
    liveness: "A2A_RESPONDED";
    compatibility: "DECLARED_ONLY_DELIVERY_VALIDATION_PENDING";
    activation: "SIGNED_QUOTE_ACCEPTED_FUNDING_NOT_PERFORMED";
    selection: "NOT_ELIGIBLE_YET";
  };
  boundary: string;
}

export async function requestBnbLpRangeQuote(
  input: LpRebalanceRequest,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<BnbLpRangeQuoteTrace> {
  const frozenRequest = LpRebalanceRequestSchema.parse(input);
  const nativeRequest = buildBnbLpRangeQuoteRequest(frozenRequest);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const startedClock = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("external A2A timeout"), 12_000);
  let response: Response;
  try {
    response = await fetchImpl(BNB_LP_RANGE_PROVIDER.endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(nativeRequest),
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`External LP quote failed with HTTP ${response.status}`);
  }

  const envelope = QuoteEnvelopeSchema.parse(await readBoundedJson(response));
  if (envelope.id !== nativeRequest.id) {
    throw new Error("External LP quote does not bind the JSON-RPC request id");
  }
  const quote = envelope.result.parts[0]!.data;
  const expectedDescription = taskDescription(frozenRequest);
  if (
    quote.request.task_description !== expectedDescription ||
    quote.request.terms.deliverables !== quoteTerms.deliverables ||
    quote.request.terms.quality_standards !== quoteTerms.quality_standards ||
    quote.response.terms.deliverables !== quoteTerms.deliverables ||
    quote.response.terms.quality_standards !== quoteTerms.quality_standards
  ) {
    throw new Error("External LP quote changed the frozen job or quality terms");
  }
  if (!sameAddress(quote.verifying_contract, BNB_LP_RANGE_PROVIDER.kernel)) {
    throw new Error("External LP quote uses an unexpected ERC-8183 kernel");
  }
  if (!sameAddress(quote.response.terms.currency, BNB_LP_RANGE_PROVIDER.paymentToken)) {
    throw new Error("External LP quote uses an unexpected payment token");
  }
  if (BigInt(quote.response.terms.price) > BigInt(BNB_LP_RANGE_PROVIDER.maximumPriceAtomic)) {
    throw new Error("External LP quote exceeds the frozen maximum price");
  }
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (quote.response.quote_expires_at <= nowSeconds) {
    throw new Error("External LP quote is already expired");
  }
  if (
    quote.response.negotiated_at > nowSeconds + 60 ||
    quote.response.negotiated_at < nowSeconds - 300
  ) {
    throw new Error("External LP quote negotiation time is outside the admitted window");
  }
  const recoveredSigner = verifyMessage(quote.negotiation_hash, quote.provider_sig);
  if (!sameAddress(recoveredSigner, BNB_LP_RANGE_PROVIDER.registryOwner)) {
    throw new Error("External LP quote signer does not match the frozen ERC-8004 owner");
  }

  const completedAt = new Date();
  return {
    schemaVersion: "positioncrew.live-match.lp-quote-trace.v1",
    adapterId: "positioncrew:a2a:bnb-lp-range:quote:v1",
    providerAgentTokenId: BNB_LP_RANGE_PROVIDER.agentTokenId,
    endpoint: BNB_LP_RANGE_PROVIDER.endpoint,
    frozenRequest,
    frozenRequestHash: canonicalHash(frozenRequest),
    nativeRequest,
    nativeRequestHash: canonicalHash(nativeRequest),
    startedAt: now.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMilliseconds: Math.round(performance.now() - startedClock),
    quote,
    recoveredSigner,
    states: {
      identity: "FROZEN_REGISTRY_OWNER_SIGNATURE_MATCHED",
      liveness: "A2A_RESPONDED",
      compatibility: "DECLARED_ONLY_DELIVERY_VALIDATION_PENDING",
      activation: "SIGNED_QUOTE_ACCEPTED_FUNDING_NOT_PERFORMED",
      selection: "NOT_ELIGIBLE_YET",
    },
    boundary:
      "This trace proves an identity-bound signed quote for the exact current LP request. It does not prove a compatible delivery, payment, provider selection, LP execution, or investment performance.",
  };
}

export function bnbLpRangePaymentContract(): {
  provider: string;
  kernel: string;
  paymentToken: string;
  maximumPriceAtomic: string;
} {
  return {
    provider: BNB_LP_RANGE_PROVIDER.registryOwner,
    kernel: BNB_LP_RANGE_PROVIDER.kernel,
    paymentToken: BNB_LP_RANGE_PROVIDER.paymentToken,
    maximumPriceAtomic: BNB_LP_RANGE_PROVIDER.maximumPriceAtomic,
  };
}
