import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import lp from "../fixtures/provider-conformance/lp-valid.v2.json" with { type: "json" };
import grid from "../fixtures/provider-conformance/grid-valid.v2.json" with { type: "json" };
import yieldFixture from "../fixtures/yield-optimization/venus-to-beefy.v1.json" with { type: "json" };
const mocks = vi.hoisted(() => ({
  lp: vi.fn(),
  yield: vi.fn(),
  grid: vi.fn(),
  client: {
    getChainId: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
    sendRawTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransactionCount: vi.fn(),
    call: vi.fn(),
    estimateGas: vi.fn(),
    getGasPrice: vi.fn(),
  },
  sign: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("../src/telemetry/bsc.js", () => ({
  inspectPancakePosition: mocks.lp,
  inspectVenusStableYields: mocks.yield,
  inspectPancakeGridMarket: mocks.grid,
}));
import {
  TERMIX_SERVICES,
  CapitalBuyerRequestSchema,
  observeCapital,
  type TermixService,
} from "../src/commerce/termix-capital-services.js";
import {
  createTermixIntakeFromOrderScope,
  createTermixIntakeFromRuntimeMessage,
  prepareTermixArtifact,
  termixDeliveryArtifactDescriptor,
  assertTermixArtifactOrder,
} from "../src/commerce/termix-provider-delivery.js";
import {
  runTermixFulfillment,
  deliveryJournalName,
  validateDeliveryPolicy,
  assertDeliverySigningWindow,
  assertDeliveryWindow,
} from "../src/cli/fulfill-termix-lending.js";
import {
  validateServicePolicy,
  reserveOrder,
  assertServiceOrder,
} from "../src/commerce/termix-service-policy.js";
import { canonicalHash } from "../src/core/canonical.js";
const now = Date.parse("2026-08-12T16:00:30Z");
const buyer = "buyer-1",
  id = "cmtw06pvw2we4w001ng4tl6sj";
function requirements(service: TermixService) {
  const base = {
    schemaVersion: "positioncrew.termix-capital-request.v1",
    service,
    analysisOnly: true,
    maxActionUsd: "1000",
    maxGasUsd: "5",
    maxSlippageBps: 10,
  };
  if (service === "LP_REBALANCE") {
    const {
      tickSpacing,
      estimatedGasUsd,
      estimatedSwapCostUsd,
      ...constraints
    } = lp.constraints;
    return { ...base, positionTokenId: "1456267", constraints };
  }
  if (service === "BOUNDED_GRID") {
    const { estimatedGasUsd, capitalUsd, ...constraints } = grid.constraints;
    return {
      ...base,
      account: grid.account,
      capitalUsd: "1000",
      capitalSource: "HYPOTHETICAL",
      constraints: { ...constraints, levelCount: 5, orderExpirySeconds: 120 },
    };
  }
  return {
    ...base,
    account: yieldFixture.account,
    capitalUsd: "1000",
    capitalSource: "HYPOTHETICAL",
    maxExecutionCostUsd: "5",
    constraints: yieldFixture.constraints,
  };
}
function order(
  service: TermixService,
  scope = JSON.stringify(requirements(service)),
) {
  const identity = TERMIX_SERVICES[service];
  return {
    id,
    chainOrderId: "0x" + "11".repeat(32),
    budget: "5",
    currency: "USDC",
    status: "FUNDED",
    buyer: { id: buyer, clientAgentId: "buyer-agent" },
    seller: { id: identity.agentId },
    listingId: identity.listingId,
    createdAt: "2026-08-12T16:00:00Z",
    deadlines: { deliveryDueAt: "2026-08-13T16:00:00Z" },
    redoUsed: false,
    availableActions: { canSubmitDelivery: true },
    scope: "Service description\nBuyer requirements:\n" + scope,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  const source = {
    blockNumber: "123",
    explorerUrl: "https://bscscan.com/block/123",
  };
  mocks.lp.mockResolvedValue({
    lpRequest: structuredClone(lp),
    source,
    generatedAt: new Date(now).toISOString(),
  });
  mocks.yield.mockResolvedValue({
    yieldRequest: structuredClone(yieldFixture),
    source,
    generatedAt: new Date(now).toISOString(),
  });
  mocks.grid.mockResolvedValue({
    gridRequest: structuredClone(grid),
    source,
    generatedAt: new Date(now).toISOString(),
  });
});
describe.each(["LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"] as const)(
  "%s paid report binding",
  (service) => {
    it("seals explicit checkout requirements to the actual order without requiring an invented pre-checkout ID", () => {
      const intake = createTermixIntakeFromOrderScope(order(service));
      expect(intake.orderId).toBe(id);
      expect(intake.buyerEvidence.senderAccountId).toBe(buyer);
      expect(intake.schemaVersion).toBe(
        "positioncrew.termix-capital-intake.v1",
      );
    });
    it("rejects foreign orders, unknown fields, executable requests and another service", () => {
      for (const change of [
        { orderId: "foreign" },
        { ignoreLimits: true },
        { analysisOnly: false },
        { service: "LENDING_RESCUE" },
      ])
        expect(() =>
          createTermixIntakeFromOrderScope(
            order(
              service,
              JSON.stringify({ ...requirements(service), ...change }),
            ),
          ),
        ).toThrow();
    });
    it("rejects forged buyer chat and accepts only the exact authenticated locator", () => {
      const o = order(service),
        locator = {
          schemaVersion: "positioncrew.termix-buyer-message-locator.v1",
          orderId: id,
          conversationId: "chat",
          messageId: "message",
          since: "2026-08-12T16:00:00Z",
        },
        message = {
          orderId: id,
          conversationId: "chat",
          messageId: "message",
          kind: "TEXT",
          text: JSON.stringify(requirements(service)),
          from: { accountId: buyer },
          createdAt: "2026-08-12T16:00:01Z",
        };
      expect(
        createTermixIntakeFromRuntimeMessage(o, locator, message).orderId,
      ).toBe(id);
      expect(() =>
        createTermixIntakeFromRuntimeMessage(o, locator, {
          ...message,
          from: { accountId: "attacker" },
        }),
      ).toThrow();
    });
    it("creates a downloadable report bound to service, order and actual buyer limits", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const o = order(service),
          intake = createTermixIntakeFromOrderScope(o);
        const artifact = await prepareTermixArtifact(o, intake),
          descriptor = termixDeliveryArtifactDescriptor(artifact);
        expect(artifact.request.service).toBe(service);
        expect(artifact.request.maxActionUsd).toBe("1000");
        expect(artifact.evaluation.passed).toBe(true);
        expect(JSON.parse(descriptor.content).order.id).toBe(id);
        expect(descriptor.fileName).toContain(service.toLowerCase());
        expect(() =>
          assertTermixArtifactOrder(artifact, { ...o, redoUsed: true }),
        ).toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
    it("reserves from one fleet budget and applies the shorter artifact recovery window", () => {
      const o = order(service),
        intake = createTermixIntakeFromOrderScope(o),
        identity = TERMIX_SERVICES.LENDING_RESCUE;
      const policy = validateServicePolicy(
        {
          schemaVersion: "positioncrew.termix-service-policy.v1",
          enabledServices: ["LENDING_RESCUE", service],
          startsAt: "2026-08-12T15:00:00Z",
          expiresAt: "2026-08-14T15:00:00Z",
          chainId: 56,
          providerAgentId: identity.agentId,
          listingId: identity.listingId,
          currency: "USDC",
          amount: "5",
          escrow: "0x" + "22".repeat(20),
          maxGasWei: "34000000000000",
          maxTotalGasWei: "2040000000000000",
          maxRollingGasWei: "408000000000000",
          maxOrders: 20,
        },
        now,
      );
      const normalized = {
        ...o,
        onChainOrderId: o.chainOrderId,
        amount: o.budget,
        providerAgentId: o.seller.id,
        clientAccountId: buyer,
        clientAgentId: o.buyer.clientAgentId,
        deliveryDueAt: o.deadlines.deliveryDueAt,
      };
      const ledger = reserveOrder(
          {
            schemaVersion: "positioncrew.termix-service-ledger.v1",
            policyHash: canonicalHash(policy),
            reservations: {},
          },
          policy,
          normalized,
          intake,
          undefined,
          now,
        ),
        p = ledger.reservations[id]!.policy;
      expect(p.service).toBe(service);
      expect(validateDeliveryPolicy(p, o, now).order.id).toBe(id);
      const expiry = new Date(now + 95000).toISOString();
      expect(() =>
        assertDeliverySigningWindow(p, o, expiry, now),
      ).not.toThrow();
      expect(() =>
        assertDeliveryWindow(p, o, expiry, now + 40000),
      ).not.toThrow();
      expect(() =>
        assertDeliverySigningWindow(
          p,
          o,
          new Date(now + 89000).toISOString(),
          now,
        ),
      ).toThrow();
      expect(() =>
        assertServiceOrder(
          normalized,
          { ...policy, enabledServices: ["LENDING_RESCUE"] },
          now,
        ),
      ).toThrow();
    });
  },
);

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, keccak256 } from "viem";
import {
  normalizeTermixProviderOrder,
  sealTermixFulfillmentCheckpoint,
  assertTermixProviderIntent,
} from "../src/commerce/termix-provider-delivery.js";
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => mocks.client,
}));
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({
    address: "0xADd748C416E8A7efd7d65D18Abb121dea268ddF9",
    signTransaction: mocks.sign,
  }),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: mocks.spawn,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe.each(["LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"] as const)(
  "%s delivery worker",
  (service) => {
    it("signs the bound delivery once, recovers without preparing again, and stops on an unknown RPC failure", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const root = mkdtempSync(join(tmpdir(), "pc-capital-worker-"));
      try {
        const o = normalizeTermixProviderOrder(order(service)),
          intake = createTermixIntakeFromOrderScope(o),
          artifact = await prepareTermixArtifact(o, intake),
          d = termixDeliveryArtifactDescriptor(artifact);
        // Start delivery at the observation timestamp, leaving the real two-minute lifetime.
        vi.setSystemTime(Date.parse(artifact.result.expiresAt) - 120000);
        const escrow = "0x" + "22".repeat(20),
          config = {
            chainId: 56,
            settlementCurrencies: [
              {
                symbol: "USDC",
                address: "0x" + "33".repeat(20),
                decimals: 18,
                providerLockBps: 0,
                contracts: { escrow },
              },
            ],
          };
        const intent = {
          id: "delivery",
          status: "PREPARED",
          nonceKey: "delivery-1",
          action: "submitDelivery",
          chainId: 56,
          value: "0",
          contract: escrow,
          callData: encodeFunctionData({
            abi: parseAbi([
              "function submitDelivery(bytes32 orderId, bytes32 deliveryHash)",
            ]),
            functionName: "submitDelivery",
            args: [
              o.onChainOrderId as `0x${string}`,
              d.deliveryHash as `0x${string}`,
            ],
          }),
        };
        const guard = assertTermixProviderIntent(
          o,
          config,
          intent,
          "submitDelivery",
          { expectedDeliveryHash: d.deliveryHash },
        );
        const p = {
          service,
          orderId: id,
          scopeHash: canonicalHash(o.scope),
          clientAccountId: buyer,
          onChainOrderId: o.onChainOrderId,
          expiresAt: "2026-08-13T16:00:00Z",
          currency: "USDC",
          escrow,
          intakeHash: canonicalHash(intake),
          maxGasWei: "34000000000000",
        };
        for (const [name, value] of Object.entries({
          policy: JSON.stringify(p),
          session: "fake-session",
          key: "fake-key",
          artifact: d.content,
        }))
          writeFileSync(join(root, name), value, { mode: 0o600 });
        for (const [key, value] of Object.entries({
          TERMIX_DELIVERY_POLICY_FILE: join(root, "policy"),
          TERMIX_SESSION_TOKEN_FILE: join(root, "session"),
          TERMIX_DELIVERY_OWNER_KEY_FILE: join(root, "key"),
          TERMIX_FULFILLMENT_STATE_DIR: root,
        }))
          vi.stubEnv(key, value);
        const checkpoint = sealTermixFulfillmentCheckpoint({
          schemaVersion: "positioncrew.termix-fulfillment.v2",
          chainId: 56,
          baseUrl: "https://platform-backend.prod.termix.live",
          providerAgentId: o.providerAgentId,
          listingId: o.listingId,
          orderId: id,
          deliveryRound: 1,
          stage: "SUBMIT_INTENT_PREPARED",
          order: o,
          orderHash: canonicalHash(o),
          intake,
          intakeHash: canonicalHash(intake),
          artifact: {
            fileName: d.fileName,
            contentType: d.contentType,
            sizeBytes: d.sizeBytes,
            sha256: d.sha256,
            deliveryHash: d.deliveryHash,
            manifestSource: "TERMIX_ARTIFACT_IDS",
            localPath: join(root, "artifact"),
            remoteArtifactId: "registered-artifact",
            publicUrl: "https://example.com/artifact",
            resultExpiresAt: artifact.result.expiresAt,
          },
          acceptIntent: null,
          acceptIntentHash: null,
          submitIntent: guard.intent,
          submitIntentHash: guard.intentHash,
          preparedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          boundaries: {
            acceptanceBroadcast: false,
            deliveryBroadcast: false,
            walletSignatureCreated: false,
            settlementCompleted: false,
          },
        });
        mocks.spawn.mockImplementation(() => {
          writeFileSync(
            join(root, canonicalHash(id).slice(7) + ".json"),
            JSON.stringify(checkpoint),
            { mode: 0o600 },
          );
          return { status: 0, stderr: "", stdout: "" };
        });
        mocks.client.getChainId.mockResolvedValue(56);
        mocks.client.call.mockResolvedValue({ data: "0x" });
        mocks.client.estimateGas.mockResolvedValue(100000n);
        mocks.client.getGasPrice.mockResolvedValue(100000000n);
        mocks.client.getTransactionCount.mockResolvedValue(3);
        mocks.sign.mockResolvedValue("0x12");
        mocks.client.sendRawTransaction.mockResolvedValue(keccak256("0x12"));
        const receipt = {
          status: "success",
          gasUsed: 100000n,
          effectiveGasPrice: 100000000n,
        };
        mocks.client.waitForTransactionReceipt.mockResolvedValue(receipt);
        mocks.client.getTransactionReceipt.mockResolvedValue(receipt);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async (input: unknown) =>
              new Response(
                JSON.stringify(
                  String(input).endsWith("/config/contracts") ? config : o,
                ),
                { status: 200 },
              ),
          ),
        );
        vi.spyOn(console, "log").mockImplementation(() => {});
        await runTermixFulfillment();
        expect(mocks.sign).toHaveBeenCalledTimes(1);
        expect(mocks.sign.mock.calls[0]![0]).toMatchObject({
          to: escrow,
          data: intent.callData,
          value: 0n,
        });
        expect(mocks.spawn.mock.calls[0]![2].env.TERMIX_AGENT_ID).toBe(
          TERMIX_SERVICES[service].agentId,
        );
        const signed = JSON.parse(
          readFileSync(join(root, deliveryJournalName(id, false)), "utf8"),
        );
        expect(signed.hash).toBe(keccak256("0x12"));
        await runTermixFulfillment();
        expect(mocks.sign).toHaveBeenCalledTimes(1);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        mocks.client.getTransactionReceipt.mockRejectedValueOnce(
          new Error("RPC offline"),
        );
        await expect(runTermixFulfillment()).rejects.toThrow("RPC offline");
        expect(mocks.client.sendRawTransaction).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);

it("shares one admission cap across services and retains existing reservations", () => {
  const identity = TERMIX_SERVICES.LENDING_RESCUE;
  const policy = validateServicePolicy(
    {
      schemaVersion: "positioncrew.termix-service-policy.v1",
      enabledServices: [
        "LENDING_RESCUE",
        "LP_REBALANCE",
        "YIELD_OPTIMIZATION",
        "BOUNDED_GRID",
      ],
      startsAt: "2026-08-12T15:00:00Z",
      expiresAt: "2026-08-14T15:00:00Z",
      chainId: 56,
      providerAgentId: identity.agentId,
      listingId: identity.listingId,
      currency: "USDC",
      amount: "5",
      escrow: "0x" + "22".repeat(20),
      maxGasWei: "34000000000000",
      maxTotalGasWei: "2040000000000000",
      maxRollingGasWei: "204000000000000",
      maxOrders: 20,
    },
    now,
  );
  let ledger: ReturnType<typeof reserveOrder> = {
    schemaVersion: "positioncrew.termix-service-ledger.v1",
    policyHash: canonicalHash(policy),
    reservations: {},
  };
  for (const [index, service] of (
    ["LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"] as const
  ).entries()) {
    const o = normalizeTermixProviderOrder({
      ...order(service),
      id: id.slice(0, -1) + index,
    });
    const intake = createTermixIntakeFromOrderScope(o);
    if (index < 2)
      ledger = reserveOrder(ledger, policy, o, intake, undefined, now);
    else
      expect(() =>
        reserveOrder(ledger, policy, o, intake, undefined, now),
      ).toThrow("admission budget exhausted");
  }
  expect(
    Object.values(ledger.reservations).map((r) => r.policy.service),
  ).toEqual(["LP_REBALANCE", "YIELD_OPTIMIZATION"]);
});

it("rejects Grid expiries that cannot retain paid-delivery signing headroom", () => {
  const r = requirements("BOUNDED_GRID");
  for (const seconds of [60, 89, 90, 119]) {
    expect(() =>
      createTermixIntakeFromOrderScope(
        order(
          "BOUNDED_GRID",
          JSON.stringify({
            ...r,
            constraints: { ...r.constraints, orderExpirySeconds: seconds },
          }),
        ),
      ),
    ).toThrow();
  }
  expect(() =>
    createTermixIntakeFromOrderScope(
      order(
        "BOUNDED_GRID",
        JSON.stringify({
          ...r,
          constraints: { ...r.constraints, orderExpirySeconds: 120 },
        }),
      ),
    ),
  ).not.toThrow();
});
