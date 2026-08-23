import { describe, expect, it } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem";
import {
  AACP_MAINNET_IDENTITY_EVIDENCE,
  AACP_MAINNET_LISTING_EVIDENCE,
  AACP_DEDICATED_LENDING_EVIDENCE,
  AACP_RUNTIME_ROTATION_EVIDENCE,
  AACP_PROVIDER_BLUEPRINTS,
  fetchAacpProductionConfig,
  getAacpProductionReadiness,
  unavailableAacpProductionReadiness,
} from "../src/commerce/aacp-production.js";

const ERC8004_IDENTITY_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

const ADDRESSES = {
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  reputation: "0xFf3f7038c4919A420B30D7B3533cb386D5898189",
  usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  usdcEscrow: "0x6A52ba4C84b348FaEAe13dDC7A97b4F6af23913C",
  usdcStaking: "0x0Bd066f5113e6B8336b06F8Aa3EF90D37F7e65FC",
  usdcCampaign: "0x5BaE7834B32a4b357F65dd20248068993466D294",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  usdtEscrow: "0xCE02f987D8b8AF694E13C8a843Db9c77caBF544c",
  usdtStaking: "0x1DcafFB7275fa2650d480a4F939A0C0D5874750B",
  usdtCampaign: "0x16261F2BCbE8Ee47065C5ecB4be32c1571289809",
} as const;

function descriptor(name: string, address: string) {
  return { name, address, abi: name, configured: true };
}

function productionConfig() {
  return {
    environment: "production",
    chainId: 56,
    network: "bnb-chain",
    networkLabel: "BNB Chain",
    explorerBaseUrl: "https://bscscan.com",
    protocolFeeBps: 200,
    campaignProtocolFeeBps: 200,
    settlementCurrency: {
      symbol: "USDC",
      decimals: 18,
      address: ADDRESSES.usdc,
    },
    settlementCurrencies: [
      {
        symbol: "USDC",
        decimals: 18,
        address: ADDRESSES.usdc,
        default: true,
        protocolFeeBps: 200,
        providerLockBps: 0,
        contracts: {
          escrow: ADDRESSES.usdcEscrow,
          staking: ADDRESSES.usdcStaking,
          campaignVault: ADDRESSES.usdcCampaign,
        },
      },
      {
        symbol: "USDT",
        decimals: 18,
        address: ADDRESSES.usdt,
        default: false,
        protocolFeeBps: 200,
        providerLockBps: 0,
        contracts: {
          escrow: ADDRESSES.usdtEscrow,
          staking: ADDRESSES.usdtStaking,
          campaignVault: ADDRESSES.usdtCampaign,
        },
      },
    ],
    settlementChains: [
      {
        id: 56,
        name: "BNB Chain",
        default: true,
        explorerBaseUrl: "https://bscscan.com",
      },
    ],
    contracts: {
      identityRegistry: descriptor("IdentityRegistry", ADDRESSES.identity),
      agentNft: descriptor("IdentityRegistry", ADDRESSES.identity),
      escrow: descriptor("TermixEscrow", ADDRESSES.usdcEscrow),
      staking: descriptor("TermixStaking", ADDRESSES.usdcStaking),
      reputation: descriptor("TermixReputation", ADDRESSES.reputation),
      usdc: descriptor("USDC", ADDRESSES.usdc),
      campaignVault: descriptor("CampaignVault", ADDRESSES.usdcCampaign),
    },
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockedFetch(options: {
  missingCodeAt?: number;
  chainId?: string;
  listingStatus?: number;
  listingA2aStatus?: string;
  listingPresence?: string;
  wrongIdentityOwner?: boolean;
  wrongDedicatedIdentityOwner?: boolean;
  wrongDedicatedMetadata?: boolean;
  rpcGate?: Promise<void>;
  requestLog?: string[];
} = {}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/config/contracts")) return json(productionConfig());
    if (url.includes("/api/v1/listings/")) {
      if (options.listingStatus) {
        return json({ error: "listing unavailable" }, options.listingStatus);
      }
      const listingId = url.split("/").at(-1);
      const listing = AACP_MAINNET_LISTING_EVIDENCE.listings.find(
        (candidate) => candidate.listingId === listingId,
      );
      if (listingId === AACP_DEDICATED_LENDING_EVIDENCE.listingId) {
        options.requestLog?.push("dedicated-listing");
        const dedicated = AACP_DEDICATED_LENDING_EVIDENCE;
        return json({
          id: dedicated.listingId,
          title: dedicated.title,
          category: dedicated.category,
          skillTag: dedicated.skillTag,
          tags: dedicated.tags,
          description: dedicated.description,
          status: "PUBLISHED",
          instantBuyable: dedicated.instantBuyable,
          coverImageUrl: dedicated.coverImageUrl,
          coverImageAlt: null,
          basePrice: dedicated.basePrice,
          currency: dedicated.currency,
          deliveryDays: dedicated.deliveryDays,
          proofMethod: dedicated.proofMethod,
          settlementType: dedicated.settlementType,
          challengeWindowHours: dedicated.challengeWindowHours,
          bondAmount: dedicated.bondAmount,
          publicSearch: dedicated.publicSearch,
          createdAt: dedicated.createdAt,
          providerAgent: {
            id: dedicated.agentId,
            agentTokenId: dedicated.agentTokenId,
            name: dedicated.handle,
            a2aStatus: options.listingA2aStatus ?? "ONLINE",
            presence: options.listingPresence ?? "online",
            verified: false,
          },
          packages: [],
        });
      }
      if (!listing) return json({ error: "unknown listing" }, 404);
      const blueprint = AACP_PROVIDER_BLUEPRINTS.find(
        (candidate) => candidate.service === listing.service,
      );
      if (!blueprint) throw new Error(`Unexpected service ${listing.service}`);
      return json({
        id: listing.listingId,
        title: listing.title,
        category: listing.category,
        skillTag: listing.skillTag,
        tags: listing.tags,
        description: blueprint.listing.description,
        status: "PUBLISHED",
        instantBuyable: listing.instantBuyable,
        coverImageUrl: listing.coverImageUrl,
        coverImageAlt: null,
        basePrice: listing.basePrice,
        currency: listing.currency,
        deliveryDays: listing.deliveryDays,
        proofMethod: listing.proofMethod,
        settlementType: listing.settlementType,
        challengeWindowHours: listing.challengeWindowHours,
        bondAmount: listing.bondAmount,
        publicSearch: listing.publicSearch,
        createdAt: listing.createdAt,
        providerAgent: {
          id: listing.agentId,
          agentTokenId: listing.agentTokenId,
          name: listing.handle,
          a2aStatus: options.listingA2aStatus ?? "UNBOUND",
          presence: options.listingPresence ?? "recent",
          verified: false,
        },
        packages: ["basic", "standard", "premium"].map((id) => ({
          id,
          price: listing.basePrice,
          scope: listing.packageScope,
          delivery: String(listing.deliveryDays),
        })),
      });
    }
    if (init?.method === "POST") {
      options.requestLog?.push("rpc");
      await options.rpcGate;
      const calls = JSON.parse(String(init.body)) as Array<{
        id: number;
        method: string;
        params: unknown[];
      }>;
      let codeIndex = 0;
      return json(
        calls.map((call) => {
          let result = "0x60006000";
          if (call.method === "eth_chainId") result = options.chainId ?? "0x38";
          if (call.method === "eth_blockNumber") result = "0x1234";
          if (call.method === "eth_getCode") {
            if (codeIndex === options.missingCodeAt) result = "0x";
            codeIndex += 1;
          }
          if (call.method === "eth_call") {
            const request = call.params[0] as { data: `0x${string}` };
            const tokenId = BigInt(`0x${request.data.slice(10)}`).toString();
            const identity = AACP_MAINNET_IDENTITY_EVIDENCE.providers.find(
              (provider) => provider.agentTokenId === tokenId,
            ) ?? (AACP_DEDICATED_LENDING_EVIDENCE.agentTokenId === tokenId
              ? AACP_DEDICATED_LENDING_EVIDENCE
              : undefined);
            if (!identity) throw new Error(`Unexpected identity token ${tokenId}`);
            const dedicated = identity.agentTokenId === AACP_DEDICATED_LENDING_EVIDENCE.agentTokenId;
            if (request.data.startsWith("0x6352211e")) {
              result = encodeFunctionResult({
                abi: ERC8004_IDENTITY_ABI,
                functionName: "ownerOf",
                result: options.wrongIdentityOwner || (dedicated && options.wrongDedicatedIdentityOwner)
                  ? "0x000000000000000000000000000000000000dEaD"
                  : (dedicated ? AACP_DEDICATED_LENDING_EVIDENCE.owner : AACP_MAINNET_IDENTITY_EVIDENCE.owner) as `0x${string}`,
              });
            } else {
              result = encodeFunctionResult({
                abi: ERC8004_IDENTITY_ABI,
                functionName: "tokenURI",
                result: dedicated && options.wrongDedicatedMetadata
                  ? "https://example.com/changed-metadata.json"
                  : identity.metadataUrl,
              });
            }
          }
          return { jsonrpc: "2.0", id: call.id, result };
        }),
      );
    }
    return json({ error: "unexpected URL" }, 404);
  }) as typeof fetch;
}

describe("dedicated TermiX flagship evidence", () => {
  it("preserves the original four providers while reporting the additional live listing separately", async () => {
    const readiness = await getAacpProductionReadiness({ fetchImpl: mockedFetch() });
    expect(readiness.marketplace.providers).toHaveLength(4);
    expect(readiness.marketplace.dedicatedFlagship).toMatchObject({
      agentId: "cmt4dzxvcli4tw70125nd5ra8",
      agentTokenId: "293111",
      listingId: "cmt4e8j3nlmuiw7019f4qf24x",
      owner: "0xADd748C416E8A7efd7d65D18Abb121dea268ddF9",
      status: "ONLINE_AND_LISTED",
      liveListingVerified: true,
      onchainVerified: true,
    });
    expect(readiness.state).toBe("LISTINGS_PUBLISHED_RUNTIME_PENDING");
    expect(readiness.marketplace.onlineProviderCount).toBe(0);
    expect(readiness.integration.runtime).toMatchObject({
      automationScope: "DEDICATED_FLAGSHIP_ONLY",
      signerIsolation: "ROOT_ONLY_SYSTEMD_RENEWAL_UNIT",
      pollerHasSigningMaterial: false,
      originalProvidersAutoRenew: false,
      rotationEvidence: {
        verifiedRotationCount: 3,
        agentId: readiness.marketplace.dedicatedFlagship.agentId,
        agentTokenId: readiness.marketplace.dedicatedFlagship.agentTokenId,
      },
    });
  });

  it("binds three chronological production rotations to the dedicated identity", () => {
    expect(AACP_RUNTIME_ROTATION_EVIDENCE).toMatchObject({
      agentId: AACP_DEDICATED_LENDING_EVIDENCE.agentId,
      agentTokenId: AACP_DEDICATED_LENDING_EVIDENCE.agentTokenId,
      handle: AACP_DEDICATED_LENDING_EVIDENCE.handle,
      owner: AACP_DEDICATED_LENDING_EVIDENCE.owner,
    });
    expect(AACP_RUNTIME_ROTATION_EVIDENCE.rotations).toHaveLength(3);
    for (const [index, rotation] of AACP_RUNTIME_ROTATION_EVIDENCE.rotations.entries()) {
      expect(rotation.sequence).toBe(index + 1);
      expect(rotation.rotated).toBe(true);
      expect(rotation.restarted).toBe(true);
      expect(Date.parse(rotation.expiresAt)).toBeGreaterThan(
        Date.parse(rotation.completedAt),
      );
      expect(Date.parse(rotation.onlineObservation.observedAt)).toBeGreaterThan(
        Date.parse(rotation.completedAt),
      );
      expect(rotation.onlineObservation).toMatchObject({
        productionStatus: "OPERATIONAL",
        listingStatus: "PUBLISHED",
        a2aStatus: "ONLINE",
        status: "ONLINE_AND_LISTED",
      });
    }
    expect(AACP_RUNTIME_ROTATION_EVIDENCE.boundaries.join(" ")).toContain(
      "do not establish continuous uptime",
    );
  });

  it("fails closed when the dedicated NFT owner or metadata URI changes on chain", async () => {
    await expect(
      getAacpProductionReadiness({ fetchImpl: mockedFetch({ wrongDedicatedIdentityOwner: true }) }),
    ).rejects.toThrow("owner mismatch for dedicated Lending Rescue flagship");
    await expect(
      getAacpProductionReadiness({ fetchImpl: mockedFetch({ wrongDedicatedMetadata: true }) }),
    ).rejects.toThrow("metadata URI mismatch for dedicated Lending Rescue flagship");
  });

  it("starts dedicated listing discovery before the shared chain probe resolves", async () => {
    const requestLog: string[] = [];
    let releaseRpc!: () => void;
    const rpcGate = new Promise<void>((resolve) => {
      releaseRpc = resolve;
    });
    const readinessPromise = getAacpProductionReadiness({
      fetchImpl: mockedFetch({ requestLog, rpcGate }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestLog).toContain("rpc");
    expect(requestLog).toContain("dedicated-listing");
    releaseRpc();
    await expect(readinessPromise).resolves.toMatchObject({
      marketplace: { dedicatedFlagship: { status: "ONLINE_AND_LISTED" } },
    });
  });

  it("uses authoritative A2A status when account presence is stale", async () => {
    const readiness = await getAacpProductionReadiness({
      fetchImpl: mockedFetch({ listingA2aStatus: "ONLINE", listingPresence: "offline" }),
    });
    expect(readiness.marketplace.dedicatedFlagship).toMatchObject({
      a2aStatus: "ONLINE",
      presence: "offline",
      status: "ONLINE_AND_LISTED",
    });
  });
});

describe("TermiX production AACP readiness", () => {
  it("locks four distinct production provider blueprints", () => {
    expect(AACP_PROVIDER_BLUEPRINTS.map((provider) => provider.service)).toEqual([
      "LENDING_RESCUE",
      "LP_REBALANCE",
      "YIELD_OPTIMIZATION",
      "BOUNDED_GRID",
    ]);
    expect(new Set(AACP_PROVIDER_BLUEPRINTS.map((provider) => provider.handle)).size).toBe(4);
    expect(new Set(AACP_PROVIDER_BLUEPRINTS.map((provider) => provider.mintName)).size).toBe(4);
    expect(
      AACP_PROVIDER_BLUEPRINTS.every(
        (provider) => provider.handle === `${provider.mintName}.agent`,
      ),
    ).toBe(true);
    expect(AACP_PROVIDER_BLUEPRINTS.every((provider) => provider.listing.currency === "USDC")).toBe(true);
    expect(AACP_PROVIDER_BLUEPRINTS.every((provider) => provider.listing.publicSearch)).toBe(true);
    expect(AACP_PROVIDER_BLUEPRINTS.every((provider) => provider.listing.instantBuyable)).toBe(true);
  });

  it("validates production config, bytecode, and four mainnet identities", async () => {
    const readiness = await getAacpProductionReadiness({
      fetchImpl: mockedFetch(),
      now: new Date("2026-08-13T12:00:00.000Z"),
    });

    expect(readiness).toMatchObject({
      schemaVersion: "positioncrew.aacp-production-readiness.v1",
      generatedAt: "2026-08-13T12:00:00.000Z",
      state: "LISTINGS_PUBLISHED_RUNTIME_PENDING",
      network: { chainId: 56, blockNumber: "4660" },
      protocol: { protocolFeeBps: 200 },
      integration: {
        guide: {
          status: "CURRENT_HUMAN_GUIDE_VERIFIED",
          openApiStatus: "SAMPLE_SPEC_NOT_USED",
        },
        runtime: {
          status: "PREISSUED_TOKEN_ADAPTER_IMPLEMENTED",
          ownerSignerOnHost: true,
          autoRenewsToken: true,
          automationScope: "DEDICATED_FLAGSHIP_ONLY",
          pollerHasSigningMaterial: false,
          originalProvidersAutoRenew: false,
          tokenLifetimeHours: 12,
          rotationEvidence: {
            verifiedRotationCount: 3,
          },
        },
        orderGuard: {
          status: "STRICT_LOCAL_LIFECYCLE_IMPLEMENTED",
          chainId: 56,
          signerOnGuard: false,
          broadcastsTransactions: false,
          abiDecodedIntentBinding: true,
          minedTransactionBinding: true,
          indexerReconciliationRequired: true,
        },
      },
      marketplace: {
        requiredProviderCount: 4,
        registeredIdentityCount: 4,
        indexedProviderCount: 4,
        publishedListingCount: 4,
        onlineProviderCount: 0,
      },
    });
    expect(readiness.protocol.deployedCount).toBe(readiness.protocol.contractCount);
    expect(readiness.protocol.currencies.map((currency) => currency.symbol)).toEqual(["USDC", "USDT"]);
    expect(readiness.marketplace.providers.every((provider) => provider.status === "LISTED_OFFLINE")).toBe(true);
    expect(readiness.marketplace.providers.every((provider) => provider.liveListingVerified)).toBe(true);
    expect(readiness.marketplace.providers.every((provider) => provider.a2aStatus === "UNBOUND")).toBe(true);
    expect(readiness.marketplace.providers.map((provider) => provider.agentTokenId)).toEqual([
      "266229",
      "266231",
      "266232",
      "266234",
    ]);
    expect(readiness.marketplace.providers.every((provider) => provider.identity.onchainVerified)).toBe(true);
    expect(readiness.integration.lifecycle).toContain("PENDING_OR_EXPIRED_CANCELLATION");
    expect(readiness.integration.lifecycle).toContain("BUYER_RELEASE_REDO_DISPUTE_OR_TIMEOUT");
    expect(readiness.integration.runtime.operatorRequiredConversationKinds).toContain("CHALLENGE");
    expect(readiness.boundaries.join(" ")).toContain("does not claim");
  });

  it("fails closed when the upstream config moves to another chain", async () => {
    const config = productionConfig();
    config.chainId = 97;
    const fetchImpl = (async () => json(config)) as typeof fetch;

    await expect(fetchAacpProductionConfig({ fetchImpl })).rejects.toThrow();
  });

  it("fails closed when a settlement currency omits provider lock data", async () => {
    const config = productionConfig();
    config.settlementCurrencies[0]!.providerLockBps = null as never;
    const fetchImpl = (async () => json(config)) as typeof fetch;

    await expect(fetchAacpProductionConfig({ fetchImpl })).rejects.toThrow(
      "providerLockBps must be available",
    );
  });

  it("rejects a default-currency contract alias that points elsewhere", async () => {
    const config = productionConfig();
    config.contracts.escrow.address = ADDRESSES.usdtEscrow;
    const fetchImpl = (async () => json(config)) as typeof fetch;

    await expect(fetchAacpProductionConfig({ fetchImpl })).rejects.toThrow(
      "escrow must match the default settlement currency contract",
    );
  });

  it("rejects an RPC connected to the wrong chain", async () => {
    await expect(
      getAacpProductionReadiness({ fetchImpl: mockedFetch({ chainId: "0x61" }) }),
    ).rejects.toThrow("chain mismatch");
  });

  it("reports protocol degradation when a configured contract has no bytecode", async () => {
    const readiness = await getAacpProductionReadiness({
      fetchImpl: mockedFetch({ missingCodeAt: 0 }),
    });

    expect(readiness.state).toBe("PROTOCOL_DEGRADED");
    expect(readiness.protocol.deployedCount).toBe(readiness.protocol.contractCount - 1);
  });

  it("fails closed when an ERC-8004 identity is no longer owned by the recorded wallet", async () => {
    await expect(
      getAacpProductionReadiness({ fetchImpl: mockedFetch({ wrongIdentityOwner: true }) }),
    ).rejects.toThrow("owner mismatch");
  });

  it("fails closed when direct Agent.family listing verification is unavailable", async () => {
    const readiness = await getAacpProductionReadiness({
      fetchImpl: mockedFetch({ listingStatus: 500 }),
    });

    expect(readiness.state).toBe("MARKETPLACE_DISCOVERY_DEGRADED");
    expect(readiness.protocol.deployedCount).toBe(readiness.protocol.contractCount);
    expect(readiness.marketplace.discoveryDegraded).toBe(true);
    expect(readiness.marketplace.providers.every((provider) => provider.status === "LISTING_DISCOVERY_UNAVAILABLE")).toBe(true);
    expect(readiness.marketplace.providers.every((provider) => provider.liveListingVerified === false)).toBe(true);
  });

  it("does not mistake account presence for an online A2A runtime", async () => {
    const readiness = await getAacpProductionReadiness({
      fetchImpl: mockedFetch({ listingPresence: "online", listingA2aStatus: "UNBOUND" }),
    });

    expect(readiness.state).toBe("LISTINGS_PUBLISHED_RUNTIME_PENDING");
    expect(readiness.marketplace.onlineProviderCount).toBe(0);
    expect(readiness.marketplace.providers.every((provider) => provider.status === "LISTED_OFFLINE")).toBe(true);
  });

  it("reports providers online only from the A2A runtime status", async () => {
    const readiness = await getAacpProductionReadiness({
      fetchImpl: mockedFetch({ listingA2aStatus: "ONLINE", listingPresence: "offline" }),
    });

    expect(readiness.state).toBe("PROVIDERS_ONLINE");
    expect(readiness.marketplace.onlineProviderCount).toBe(4);
    expect(readiness.marketplace.dedicatedFlagship.status).toBe("ONLINE_AND_LISTED");
    expect(readiness.marketplace.requiredProviderCount).toBe(4);
    expect(readiness.boundaries.join(" ")).toContain("reported an online A2A runtime");
    expect(readiness.boundaries.join(" ")).toContain("not a durable uptime claim");
  });

  it("publishes a fail-closed record when live sources are unavailable", () => {
    const readiness = unavailableAacpProductionReadiness(
      new Date("2026-08-13T12:05:00.000Z"),
    );

    expect(readiness.state).toBe("SOURCE_UNAVAILABLE");
    expect(readiness.network).toMatchObject({ chainId: 56, blockNumber: null });
    expect(readiness.marketplace.requiredProviderCount).toBe(4);
    expect(readiness.marketplace.registeredIdentityCount).toBe(0);
    expect(readiness.integration.runtime.ownerSignerOnHost).toBe(true);
    expect(readiness.integration.runtime.autoRenewsToken).toBe(true);
    expect(readiness.integration.runtime.rotationEvidence.rotations).toHaveLength(3);
    expect(readiness.marketplace.dedicatedFlagship.status).toBe("UPSTREAM_UNAVAILABLE");
    expect(readiness.boundaries.join(" ")).toContain(
      "current runtime presence is unavailable and is not inferred",
    );
    expect(readiness.integration.orderGuard.guardedActions).toHaveLength(10);
    expect(readiness.marketplace.providers.every((provider) => provider.status === "UPSTREAM_UNAVAILABLE")).toBe(true);
    expect(readiness.boundaries.join(" ")).toContain("no cached deployment claim");
  });
});
