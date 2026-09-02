import { BNB_TESTNET, createClient, signerFromPrivateKey, type Session } from "@altananetwork/sdk";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { z } from "zod";

export const ALTANA_VENUS_ACTOR = "0x50da554F1bF6A86469DB201C56bfe967d2E7c43d" as Address;
export const ALTANA_VENUS_VBNB = "0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c" as Address;
export const ALTANA_VENUS_MINT_SELECTOR = "0x1249c58b" as Hex;
export const ALTANA_VENUS_SUPPLY_WEI = 100_000_000_000_000n;
export const ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI = 100_000_000_000_000n;
export const ALTANA_VENUS_DAILY_ACTIVATION_LIMIT = 8;
export const ALTANA_VENUS_CLAIM_BOUNDARY =
  "Founder-funded BSC Testnet sandbox action. It proves one selector-bound Altana session execution and durable before/after evidence; it is not a mainnet lending rescue, user custody, payment, revenue, yield, or investment-performance claim.";

export const AltanaVenusActivationRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.altana-venus-activation.request.v1"),
  sourceHireId: z.string().uuid(),
  sourceReceiptId: z.string().uuid(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

export type AltanaVenusActivationRequest = z.infer<typeof AltanaVenusActivationRequestSchema>;

export const AltanaVenusSessionSecretSchema = z.object({
  schemaVersion: z.literal("positioncrew.altana-venus-session-secret.v1"),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  publicKey: z.string().regex(/^0x[0-9a-fA-F]+$/),
  expiry: z.number().int().positive(),
  grantTransactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  permissions: z.object({
    calls: z.tuple([z.object({
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      signature: z.literal("mint()"),
    }).strict()]),
    spend: z.tuple([z.object({
      limit: z.string().regex(/^\d+$/),
      period: z.literal("minute"),
    }).strict()]),
  }).strict(),
}).strict();

export type AltanaVenusSessionSecret = z.infer<typeof AltanaVenusSessionSecretSchema>;

export interface AltanaVenusExecutionEvidence {
  chainId: 97;
  actor: Address;
  target: Address;
  selector: Hex;
  suppliedWei: string;
  transactionHash: Hex;
  callsId: Hex;
  beforeBlockNumber: string;
  confirmedBlockNumber: string;
  vTokenBalanceBefore: string;
  vTokenBalanceAfter: string;
  vTokenDelta: string;
  session: {
    publicKey: Hex;
    expiry: number;
    grantTransactionHash: Hex;
    permissions: {
      calls: [{ to: Address; signature: "mint()" }];
      spend: [{ limit: string; period: "minute" }];
    };
  };
}

export type AltanaVenusConfirmedExecution = Omit<
  AltanaVenusExecutionEvidence,
  "vTokenBalanceAfter" | "vTokenDelta"
>;

export class AltanaConfirmationPersistenceError extends Error {
  readonly code = "ALTANA_CONFIRMATION_PERSISTENCE_FAILED";
  constructor(
    readonly confirmation: AltanaVenusConfirmedExecution,
    options?: ErrorOptions,
  ) {
    super("A confirmed transaction could not yet be persisted", options);
    this.name = "AltanaConfirmationPersistenceError";
  }
}

const BALANCE_OF_ABI = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;

export function parseAltanaVenusSessionSecret(serialized: string, now = Date.now()): {
  session: Session;
  grantTransactionHash: Hex;
} {
  const parsed = AltanaVenusSessionSecretSchema.parse(JSON.parse(serialized));
  const signer = signerFromPrivateKey(parsed.privateKey as Hex);
  const walletAddress = getAddress(parsed.walletAddress);
  const target = getAddress(parsed.permissions.calls[0].to);
  if (walletAddress !== getAddress(ALTANA_VENUS_ACTOR)) throw new Error("ALTANA_SESSION_ACTOR_MISMATCH");
  if (target !== getAddress(ALTANA_VENUS_VBNB)) throw new Error("ALTANA_SESSION_TARGET_MISMATCH");
  if (signer.publicKey.toLowerCase() !== parsed.publicKey.toLowerCase()) {
    throw new Error("ALTANA_SESSION_PUBLIC_KEY_MISMATCH");
  }
  if (parsed.expiry * 1_000 <= now + 60_000) throw new Error("ALTANA_SESSION_EXPIRED");
  if (BigInt(parsed.permissions.spend[0].limit) !== ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI) {
    throw new Error("ALTANA_SESSION_SPEND_SCOPE_MISMATCH");
  }
  return {
    session: {
      walletAddress,
      signer,
      publicKey: parsed.publicKey as Hex,
      expiry: parsed.expiry,
      permissions: {
        calls: [{ to: target, signature: "mint()" }],
        spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI, period: "minute" }],
      },
    },
    grantTransactionHash: parsed.grantTransactionHash as Hex,
  };
}

export function publicAltanaVenusSession(serialized: string, now = Date.now()) {
  const { session, grantTransactionHash } = parseAltanaVenusSessionSecret(serialized, now);
  return {
    actor: session.walletAddress,
    publicKey: session.publicKey,
    expiry: session.expiry,
    grantTransactionHash,
    permissions: {
      calls: [{ to: ALTANA_VENUS_VBNB, signature: "mint()" as const }],
      spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI.toString(), period: "minute" as const }],
    },
  };
}

export async function executeAltanaVenusActivation(
  serializedSession: string,
  onConfirmed: (evidence: AltanaVenusConfirmedExecution) => Promise<void>,
): Promise<AltanaVenusExecutionEvidence> {
  const { session, grantTransactionHash } = parseAltanaVenusSessionSecret(serializedSession);
  const rpc = createPublicClient({ chain: bscTestnet, transport: http(BNB_TESTNET.publicRpcUrl) });
  const beforeBlockNumber = await rpc.getBlockNumber();
  const before = await rpc.readContract({
    address: ALTANA_VENUS_VBNB,
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [ALTANA_VENUS_ACTOR],
    blockNumber: beforeBlockNumber,
  });
  const execution = await createClient({ chains: [BNB_TESTNET], defaultChainId: 97 }).execute({
    session,
    chainId: 97,
    calls: [{ to: ALTANA_VENUS_VBNB, value: ALTANA_VENUS_SUPPLY_WEI, data: ALTANA_VENUS_MINT_SELECTOR }],
  });
  if (execution.status !== "CONFIRMED" || !execution.transactionHash) {
    throw new Error(`ALTANA_EXECUTION_NOT_CONFIRMED:${execution.status}`);
  }
  const receipt = await rpc.waitForTransactionReceipt({ hash: execution.transactionHash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error("ALTANA_EXECUTION_REVERTED");
  const confirmed: AltanaVenusConfirmedExecution = {
    chainId: 97,
    actor: ALTANA_VENUS_ACTOR,
    target: ALTANA_VENUS_VBNB,
    selector: ALTANA_VENUS_MINT_SELECTOR,
    suppliedWei: ALTANA_VENUS_SUPPLY_WEI.toString(),
    transactionHash: execution.transactionHash,
    callsId: execution.callsId,
    beforeBlockNumber: beforeBlockNumber.toString(),
    confirmedBlockNumber: receipt.blockNumber.toString(),
    vTokenBalanceBefore: before.toString(),
    session: {
      publicKey: session.publicKey,
      expiry: session.expiry,
      grantTransactionHash,
      permissions: {
        calls: [{ to: ALTANA_VENUS_VBNB, signature: "mint()" }],
        spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI.toString(), period: "minute" }],
      },
    },
  };
  try {
    await onConfirmed(confirmed);
  } catch (cause) {
    throw new AltanaConfirmationPersistenceError(confirmed, { cause });
  }
  return completeAltanaVenusExecutionEvidence(confirmed);
}

export async function completeAltanaVenusExecutionEvidence(
  confirmed: AltanaVenusConfirmedExecution,
): Promise<AltanaVenusExecutionEvidence> {
  const rpc = createPublicClient({ chain: bscTestnet, transport: http(BNB_TESTNET.publicRpcUrl) });
  const after = await rpc.readContract({
    address: ALTANA_VENUS_VBNB,
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [ALTANA_VENUS_ACTOR],
    blockNumber: BigInt(confirmed.confirmedBlockNumber),
  });
  const delta = after - BigInt(confirmed.vTokenBalanceBefore);
  if (delta <= 0n) throw new Error("ALTANA_VTOKEN_DELTA_NOT_POSITIVE");
  return {
    ...confirmed,
    vTokenBalanceAfter: after.toString(),
    vTokenDelta: delta.toString(),
  };
}
