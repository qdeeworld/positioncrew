import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  assertTermixProviderIntent,
  assertTermixProviderOrder,
  createTermixLendingIntakeFromRuntimeMessage,
  sealTermixFulfillmentCheckpoint,
  verifyTermixFulfillmentCheckpoint,
} from "../src/commerce/termix-provider-delivery.js";

const ABI = parseAbi([
  "function acceptOrder(bytes32 orderId)",
  "function submitDelivery(bytes32 orderId, bytes32 deliveryHash)",
]);
const ORDER_ID = `0x${"11".repeat(32)}` as `0x${string}`;
const DELIVERY_HASH = `0x${"22".repeat(32)}` as `0x${string}`;
const ESCROW = "0x6A52ba4C84b348FaEAe13dDC7A97b4F6af23913C";
const NOW = new Date("2026-09-04T12:00:00.000Z");

const config = {
  chainId: 56,
  settlementCurrencies: [{
    symbol: "USDC",
    decimals: 18,
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    contracts: { escrow: ESCROW },
  }],
};

function order(status: "PENDING_ACCEPT" | "IN_PROGRESS" = "PENDING_ACCEPT") {
  return {
    id: "order-1",
    onChainOrderId: ORDER_ID,
    status,
    amount: "5",
    currency: "USDC",
    clientAgentId: "client-1",
    clientAccountId: "buyer-account-1",
    providerAgentId: "provider-1",
    listingId: "listing-1",
    acceptDeadline: "2026-09-04T13:00:00.000Z",
    deliveryDueAt: "2026-09-05T12:00:00.000Z",
    redoUsed: false,
    availableActions: {
      canProviderAccept: status === "PENDING_ACCEPT",
      canSubmitDelivery: status === "IN_PROGRESS",
    },
  };
}

function intent(action: "acceptOrder" | "submitDelivery", data: `0x${string}`) {
  return {
    action,
    chainId: 56,
    contract: ESCROW,
    callData: data,
    value: "0",
    id: `intent-${action}`,
    status: "PREPARED",
    nonceKey: `nonce-${action}`,
  };
}

describe("TermiX provider delivery guard", () => {
  it("binds an acceptance intent to the exact provider order and escrow", () => {
    const observed = assertTermixProviderOrder(order(), {
      orderId: "order-1",
      providerAgentId: "provider-1",
      listingId: "listing-1",
    });
    const guarded = assertTermixProviderIntent(
      observed,
      config,
      intent("acceptOrder", encodeFunctionData({
        abi: ABI,
        functionName: "acceptOrder",
        args: [ORDER_ID],
      })),
      "acceptOrder",
      { now: NOW },
    );
    expect(guarded.deliveryHash).toBeNull();
    expect(guarded.intentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects an acceptance intent for another on-chain order", () => {
    expect(() => assertTermixProviderIntent(
      order(),
      config,
      intent("acceptOrder", encodeFunctionData({
        abi: ABI,
        functionName: "acceptOrder",
        args: [`0x${"33".repeat(32)}` as `0x${string}`],
      })),
      "acceptOrder",
      { now: NOW },
    )).toThrow("different on-chain order");
  });

  it("binds submitDelivery to the exact reviewed artifact hash", () => {
    const submit = intent("submitDelivery", encodeFunctionData({
      abi: ABI,
      functionName: "submitDelivery",
      args: [ORDER_ID, DELIVERY_HASH],
    }));
    expect(assertTermixProviderIntent(order("IN_PROGRESS"), config, submit, "submitDelivery", {
      expectedDeliveryHash: DELIVERY_HASH,
      now: NOW,
    }).deliveryHash).toBe(DELIVERY_HASH);
    expect(() => assertTermixProviderIntent(order("IN_PROGRESS"), config, submit, "submitDelivery", {
      expectedDeliveryHash: `0x${"44".repeat(32)}`,
      now: NOW,
    })).toThrow("reviewed artifact hash");
  });

  it("constructs intake only from an order-bound TermiX buyer message", () => {
    const buyerRequest = {
      schemaVersion: "positioncrew.termix-lending-buyer-request.v1",
      orderId: "order-1",
      account: "0x0000000000000000000000000000000000000001",
      targetHealthFactor: "1.25",
      stressPriceDropBps: 1000,
      maxActionUsd: "250",
      maxGasUsd: "0.10",
      maxSlippageBps: 30,
    };
    const intake = createTermixLendingIntakeFromRuntimeMessage(order("IN_PROGRESS"), {
      schemaVersion: "positioncrew.termix-buyer-message-locator.v1",
      orderId: "order-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      since: "2026-09-04T11:59:00.000Z",
    }, {
      messageId: "message-1",
      conversationId: "conversation-1",
      orderId: "order-1",
      kind: "TEXT",
      text: JSON.stringify(buyerRequest),
      from: { accountId: "buyer-account-1" },
      createdAt: NOW.toISOString(),
    });
    expect(intake.maxActionUsd).toBe("250");
    expect(intake.buyerEvidence.senderAccountId).toBe("buyer-account-1");
  });

  it("rejects a runtime message not authored by the order client account", () => {
    expect(() => createTermixLendingIntakeFromRuntimeMessage(order("IN_PROGRESS"), {
      schemaVersion: "positioncrew.termix-buyer-message-locator.v1",
      orderId: "order-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      since: "2026-09-04T11:59:00.000Z",
    }, {
      messageId: "message-1",
      conversationId: "conversation-1",
      orderId: "order-1",
      kind: "TEXT",
      text: "{}",
      from: { accountId: "attacker-account" },
      createdAt: NOW.toISOString(),
    })).toThrow("order client account");
  });

  it("detects checkpoint mutation", () => {
    const observed = assertTermixProviderOrder(order(), {
      orderId: "order-1",
      providerAgentId: "provider-1",
      listingId: "listing-1",
    });
    const checkpoint = sealTermixFulfillmentCheckpoint({
      schemaVersion: "positioncrew.termix-lending-fulfillment.v1",
      chainId: 56,
      baseUrl: "https://platform-backend.prod.termix.live",
      providerAgentId: "provider-1",
      listingId: "listing-1",
      orderId: "order-1",
      deliveryRound: 1,
      stage: "ORDER_OBSERVED",
      order: observed,
      orderHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intake: null,
      intakeHash: null,
      artifact: null,
      acceptIntent: null,
      acceptIntentHash: null,
      submitIntent: null,
      submitIntentHash: null,
      preparedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      boundaries: {
        acceptanceBroadcast: false,
        deliveryBroadcast: false,
        walletSignatureCreated: false,
        settlementCompleted: false,
      },
    });
    expect(verifyTermixFulfillmentCheckpoint(checkpoint).orderId).toBe("order-1");
    expect(() => verifyTermixFulfillmentCheckpoint({ ...checkpoint, stage: "BLOCKED" })).toThrow(
      "hash mismatch",
    );
  });
});
