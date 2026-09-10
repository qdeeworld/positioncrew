import { z } from "zod";
import { canonicalHash } from "../core/canonical.js";
import { DeliveryPolicySchema } from "../cli/fulfill-termix-lending.js";
import { assertTermixProviderOrder, TermixContractsConfigSchema, type TermixLendingIntake } from "./termix-provider-delivery.js";

export const LENDING_AGENT = "cmt4dzxvcli4tw70125nd5ra8";
export const LENDING_LISTING = "cmt4e8j3nlmuiw7019f4qf24x";
export const SELLER_WALLET = "0xADd748C416E8A7efd7d65D18Abb121dea268ddF9" as const;
const Wei = z.string().regex(/^[1-9][0-9]*$/);
export const ServicePolicySchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-service-policy.v1"),
  startsAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  chainId: z.literal(56),
  providerAgentId: z.literal(LENDING_AGENT),
  listingId: z.literal(LENDING_LISTING),
  currency: z.enum(["USDC", "USDT"]),
  amount: z.literal("5"),
  escrow: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  maxGasWei: Wei,
  maxTotalGasWei: Wei,
  maxRollingGasWei: Wei,
  maxOrders: z.number().int().min(1).max(20),
}).strict();
export type ServicePolicy = z.infer<typeof ServicePolicySchema>;
export const ReservationSchema = z.object({
  policy: DeliveryPolicySchema,
  reservedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
}).strict();
export const ServiceLedgerSchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-service-ledger.v1"),
  policyHash: z.string(),
  reservations: z.record(z.string(), ReservationSchema),
}).strict();
export type ServiceLedger = z.infer<typeof ServiceLedgerSchema>;

export function validateServicePolicy(input: unknown, now = Date.now()) {
  const policy = ServicePolicySchema.parse(input);
  if (Date.parse(policy.startsAt) > now || Date.parse(policy.expiresAt) <= now) throw new Error("Service policy inactive or expired");
  if (Date.parse(policy.expiresAt) - Date.parse(policy.startsAt) > 14 * 86400000) throw new Error("Service policy exceeds 14 days");
  if (BigInt(policy.maxGasWei) > 34000000000000n || BigInt(policy.maxTotalGasWei) > 2040000000000000n || BigInt(policy.maxRollingGasWei) > 408000000000000n) throw new Error("Service gas budget exceeds rollout ceiling");
  return policy;
}
export function assertServiceOrder(input: unknown, policy: ServicePolicy, now = Date.now()) {
  validateServicePolicy(policy, now);
  const order = assertTermixProviderOrder(input, {orderId: z.object({id:z.string()}).parse(input).id, providerAgentId:policy.providerAgentId, listingId:policy.listingId});
  if (order.currency !== policy.currency || order.amount !== policy.amount) throw new Error("Unsupported price or currency");
  // Never enrol historical work or orders created before this deployment's policy.
  const createdAt = z.string().datetime().parse(order.createdAt);
  if (Date.parse(createdAt) < Date.parse(policy.startsAt) || Date.parse(createdAt) > now) throw new Error("Order outside policy start window");
  if (!order.deliveryDueAt || Date.parse(order.deliveryDueAt) < now + 600000) throw new Error("Insufficient delivery time");
  if (!["PENDING_ACCEPT", "FUNDED", "IN_PROGRESS"].includes(order.status)) throw new Error("Order is not actionable");
  return order;
}
export function assertZeroStakeConfig(input: unknown, policy: ServicePolicy) {
  const config = TermixContractsConfigSchema.parse(input);
  const currency = config.settlementCurrencies.find(c => c.symbol === policy.currency);
  if (!currency || currency.providerLockBps !== 0 || currency.contracts.escrow.toLowerCase() !== policy.escrow.toLowerCase()) throw new Error("Escrow changed or provider stake is nonzero/unavailable");
  return config;
}
export function reserveOrder(ledgerInput: unknown, policy: ServicePolicy, orderInput: unknown, intake: TermixLendingIntake, buyerMessage?: z.infer<typeof DeliveryPolicySchema>["buyerMessage"], now = Date.now()): ServiceLedger {
  const ledger = ServiceLedgerSchema.parse(ledgerInput);
  if (ledger.policyHash !== canonicalHash(policy)) throw new Error("Ledger belongs to another service policy");
  const order = assertServiceOrder(orderInput, policy, now);
  if (intake.orderId !== order.id || intake.buyerEvidence.senderAccountId !== order.clientAccountId) throw new Error("Intake belongs to another buyer/order");
  const perOrder = DeliveryPolicySchema.parse({orderId:order.id, onChainOrderId:order.onChainOrderId, clientAccountId:order.clientAccountId,
    scopeHash:canonicalHash(order.scope), currency:policy.currency, escrow:policy.escrow, intakeHash:canonicalHash(intake),
    expiresAt:policy.expiresAt, maxGasWei:policy.maxGasWei, ...(buyerMessage ? {buyerMessage} : {})});
  const existing = ledger.reservations[order.id];
  if (existing) {
    if (canonicalHash(existing.policy) !== canonicalHash(perOrder)) throw new Error("Reserved order requirements changed");
    return ledger;
  }
  const reservations = Object.values(ledger.reservations);
  // Reserve acceptance plus both delivery rounds upfront. Failed signed transactions
  // retain their slot; an operator must reconcile them, never silently replace them.
  const cost = 3n * BigInt(policy.maxGasWei);
  const rolling = reservations.filter(r => !r.closedAt || Date.parse(r.closedAt) > now - 86400000).length;
  if (reservations.length >= policy.maxOrders || BigInt(reservations.length + 1) * cost > BigInt(policy.maxTotalGasWei) || BigInt(rolling + 1) * cost > BigInt(policy.maxRollingGasWei)) throw new Error("Service admission budget exhausted");
  return {...ledger, reservations:{...ledger.reservations, [order.id]:{policy:perOrder, reservedAt:new Date(now).toISOString(),closedAt:null}}};
}
