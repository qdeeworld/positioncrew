import type { D1Database } from "./d1-marketplace-store.js";
import { BuyerVenusIntentSchema, type BuyerVenusIntent } from "./buyer-venus-policy.js";
import type { BuyerVenusSupplyProof } from "./buyer-venus-confirm.js";

export interface BuyerVenusState {
  version: number;
  intent: BuyerVenusIntent;
  transactions: Record<string, string>;
  confirmedSteps: number[];
  supplyProof: BuyerVenusSupplyProof | null;
  failedWithdrawals?: { transactionHash: string; blockHash: string; actualGasWei: string }[];
  withdrawal: { data: string; nonce: number; gas: string; gasPrice: string; shares: string; expectedUnderlyingRaw: string;
    treasuryPercent: string; expiresAt: string; transactionHash: string | null;
    proof: { transactionHash: string; blockHash: string; redeemedSharesRaw: string; receivedUnderlyingRaw: string; actualGasWei: string } | null } | null;
}

export class BuyerVenusStore {
  constructor(private readonly db: D1Database) {}
  async get(receiptId: string): Promise<BuyerVenusState | null> {
    const row = await this.db.prepare("SELECT state_json, row_version FROM buyer_venus_executions WHERE source_receipt_id = ?")
      .bind(receiptId).first<{ state_json: string; row_version: number }>();
    if (!row) return null;
    const state = JSON.parse(row.state_json) as BuyerVenusState;
    state.intent = BuyerVenusIntentSchema.parse(state.intent);
    if (state.version !== row.row_version || state.intent.sourceReceiptId !== receiptId) throw new Error("The saved execution record is inconsistent.");
    return state;
  }
  async create(intent: BuyerVenusIntent): Promise<BuyerVenusState> {
    const state: BuyerVenusState = { version: 0, intent, transactions: {}, confirmedSteps: [], supplyProof: null, withdrawal: null };
    const result = await this.db.prepare("INSERT OR IGNORE INTO buyer_venus_executions (source_receipt_id, row_version, state_json) VALUES (?, 0, ?)")
      .bind(intent.sourceReceiptId, JSON.stringify(state)).run();
    if (!result.success) throw new Error("The execution plan could not be saved. No transaction was submitted.");
    const saved = await this.get(intent.sourceReceiptId);
    if (!saved) throw new Error("The saved execution plan is unavailable.");
    return saved;
  }
  async update(state: BuyerVenusState): Promise<BuyerVenusState> {
    const next = { ...state, version: state.version + 1 };
    const result = await this.db.prepare("UPDATE buyer_venus_executions SET state_json = ?, row_version = ? WHERE source_receipt_id = ? AND row_version = ?")
      .bind(JSON.stringify(next), next.version, state.intent.sourceReceiptId, state.version).run();
    if (!result.success || result.meta.changes !== 1) throw new Error("The execution record changed. Reload its status before continuing.");
    return next;
  }
}
