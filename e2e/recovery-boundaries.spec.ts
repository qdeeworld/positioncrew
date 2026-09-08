import { expect, test, type Page } from "@playwright/test";
import { freshMarketplaceTaskForService, sha256Commitment } from "../src/commerce/fresh-hire-schema.js";
import { runCurrentBlockPinnedProviderDeliverable, runFrozenFixture } from "../src/api/fixture-jobs.js";
import { createLpLiveMatchAudition, selectLpLiveMatchProvider } from "../src/marketplace/lp-live-match.js";
import { LpLiveMatchAuditionSchema, LpLiveMatchExecutionSchema } from "../src/marketplace/lp-live-match-schema.js";
import { isFreshMarketplaceChainForReference } from "../web/src/job-history.js";

const hireId = "19b75690-385e-4a6c-8461-ea86f96b9c21";
const historyKey = "positioncrew.recent-jobs.v1";

async function seedSavedReference(page: Page) {
  await page.addInitScript(({ key, id }) => {
    localStorage.setItem(key, JSON.stringify({ schemaVersion: key, entries: [{
      hireId: id, service: "LENDING_RESCUE", rememberedAt: "2026-09-07T12:00:00.000Z",
    }] }));
  }, { key: historyKey, id: hireId });
}

async function createdChain(now: number, lifetime = 300_000) {
  const [benchmarkSlug, task] = freshMarketplaceTaskForService("LENDING_RESCUE")!;
  const request = { service: "LENDING_RESCUE", deadline: new Date(now + lifetime).toISOString(), maxDataAgeSeconds: 300 };
  // UI recovery fixture only. Genuine signed-observation/D1 lifecycle coverage
  // remains in the integration suite; this mock is not marketplace evidence.
  return {
    schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
    hire: { hireId, service: "LENDING_RESCUE", benchmarkSlug, providerSlug: task.providerSlug,
      providerId: "recovery-fixture-provider", request, requestHash: await sha256Commitment(request),
      evidenceMode: "CURRENT_BLOCK_PINNED", createdAt: new Date(now).toISOString(),
      evidence: { evidenceClass: "CURRENT_BLOCK_PINNED", source: { observedAt: new Date(now).toISOString() } } },
    job: { jobId: "recovery-test-job", state: "CREATED", status: "HIRE_RECORDED", error: null },
    receipt: null,
  };
}

async function stallBody(page: Page, mode: "capital" | "status" | "run") {
  await page.addInitScript(({ mode, id }) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const matches = mode === "capital"
        ? /\/api\/wallets\/.*\/venus|\/api\/markets\/venus\/stable-yields|\/api\/markets\/pancake\/wbnb-usdt\/grid/.test(url)
        : mode === "run" ? url.endsWith(`/api/benchmark-hires/${id}/jobs`) : url.endsWith(`/api/benchmark-hires/${id}`);
      if (!matches) return original(input, init);
      const signal = init?.signal;
      // Headers arrive successfully; the body stalls until the fetch signal is
      // aborted. This specifically catches clearing the deadline at headers.
      return new Response(new ReadableStream({ start(controller) {
        const abort = () => controller.error(new DOMException("Body aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      } }), { status: 200, headers: { "content-type": "application/json" } });
    };
  }, { mode, id: hireId });
}

test("capital inputs explain why checking is unavailable", async ({ page }) => {
  await page.goto("/#marketplace");
  const wallet = page.locator(".capital-check-form input").first();
  const nft = page.getByPlaceholder("Position token ID");
  await wallet.fill("0x123");
  await expect(wallet).toHaveAttribute("aria-invalid", "true");
  await expect(wallet).toHaveAttribute("aria-describedby", "capital-wallet-help");
  await expect(page.locator("#capital-wallet-help")).toContainText("exactly 40 hexadecimal");
  await wallet.fill("0x0000000000000000000000000000000000000001");
  await nft.fill("-1");
  await expect(nft).toHaveAttribute("aria-describedby", "capital-nft-help");
  await expect(page.locator("#capital-nft-help")).toContainText("positive whole-number NFT ID");
  await expect(page.locator(".capital-check-form").getByRole("button", { name: "Check my BSC capital", exact: true })).toBeDisabled();
  await nft.fill("");
  await expect(page.locator(".capital-check-form").getByRole("button", { name: "Check my BSC capital", exact: true })).toBeEnabled();
});

test("capital scan times out even when only the response body stalls", async ({ page }) => {
  await page.clock.install();
  await stallBody(page, "capital");
  await page.goto("/#marketplace");
  await page.locator(".capital-check-form input").first().fill("0x0000000000000000000000000000000000000001");
  await page.locator(".capital-check-form").getByRole("button", { name: "Check my BSC capital", exact: true }).click();
  await page.clock.fastForward(12_500);
  await expect(page.getByText("0/4 ready", { exact: true })).toBeVisible();
  await expect(page.getByText("No current jobs could be determined.", { exact: true })).toBeVisible();
});

test("saved status body timeout keeps the reference recoverable", async ({ page }) => {
  await page.clock.install();
  await seedSavedReference(page);
  await stallBody(page, "status");
  await page.goto("/#jobs");
  const panel = page.getByTestId("recent-jobs-device");
  await expect(panel.getByText("Checking", { exact: true })).toBeVisible();
  await page.clock.fastForward(10_500);
  await expect(panel.getByText("Server status request timed out", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry status" })).toBeEnabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), historyKey)).toContain(hireId);
});

test("saved current job expires on screen without offering another execution", async ({ page }) => {
  const now = Date.parse("2026-09-07T12:00:00.000Z");
  await page.clock.install({ time: new Date(now) });
  await seedSavedReference(page);
  const chain = await createdChain(now, 3_000);
  await page.route(`**/api/benchmark-hires/${hireId}`, (route) => route.fulfill({ json: chain }));
  await page.goto("/#jobs");
  const panel = page.getByTestId("recent-jobs-device");
  await expect(panel.getByRole("button", { name: "Resume run" })).toBeEnabled();
  await page.clock.fastForward(3_500);
  await expect(panel.getByText("Expired", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Resume run" })).toBeDisabled();
  await expect(panel.getByText(/load current evidence in the request panel/)).toBeVisible();
});

test("saved run body timeout returns to status recovery instead of creating another hire", async ({ page }) => {
  await page.clock.install();
  await seedSavedReference(page);
  const chain = await createdChain(Date.now());
  await page.route(`**/api/benchmark-hires/${hireId}`, (route) => route.fulfill({ json: chain }));
  await stallBody(page, "run");
  await page.goto("/#jobs");
  const panel = page.getByTestId("recent-jobs-device");
  await panel.getByRole("button", { name: "Resume run" }).click();
  await page.clock.fastForward(10_500);
  await expect(panel.getByText("Run request timed out; check this saved job's status before retrying.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry status" })).toBeEnabled();
  await panel.getByRole("button", { name: "Retry status" }).click();
  await expect(panel.getByRole("button", { name: "Resume run" })).toBeEnabled();
});

async function savedLpRefusal(code: string, detail: string, waitMilliseconds: number) {
  // Synthetic UI recovery fixture, not an external hire or financial proof.
  // Reuse the audition/selection and sealed-deliverable APIs used by the main
  // browser suite, then require the real public hydration validator to accept it.
  const baseline = await runFrozenFixture("LP_REBALANCE");
  if (baseline.result.request.service !== "LP_REBALANCE" || baseline.result.deliverable.service !== "LP_REBALANCE") {
    throw new Error("LP recovery fixture must contain an LP request and deliverable");
  }
  const request = { ...baseline.result.request, requestId: "pancake-position-1455700-1" };
  const completedAt = baseline.generatedAt;
  const startedAt = new Date(Date.parse(completedAt) - waitMilliseconds).toISOString();
  const createdAt = new Date(Date.parse(startedAt) - 10_000).toISOString();
  const observedAt = request.sources[0]?.observedAt ?? request.requestedAt;
  const requestHash = await sha256Commitment(request);
  const source = { observedAt, blockNumber: "1", explorerUrl: "https://bscscan.com/block/1" };
  const receiptId = "6ae49465-4e1d-4dc5-a614-7cda85e4a821";
  const jobId = "c472a690-385e-4a6c-8461-ea86f96b9c21";
  const initialAudition = (await createLpLiveMatchAudition(request, source, requestHash, new Date(createdAt), {
    fetchImpl: async () => { throw new Error("UI fixture: no real provider or RPC call"); },
  })).audition;
  const stubOutputHash = await sha256Commitment({ fixture: "synthetic eligible external assessment", requestHash });
  // Model an earlier successful audition, followed by the recorded delivery
  // failure. This stub is test data, not evidence that a real provider answered.
  const audition = LpLiveMatchAuditionSchema.parse({
    ...initialAudition,
    candidates: initialAudition.candidates.map((candidate) => candidate.providerKey === "HEYANON" ? {
      ...candidate,
      status: "COMPATIBLE",
      selectable: true,
      rawResponseHash: stubOutputHash,
      normalizedResponseHash: stubOutputHash,
      checks: [{ code: "UI_FIXTURE_AUDITION", status: "PASS", detail: "Synthetic eligible audition for saved-result UI recovery only." }],
    } : candidate),
  });
  const evidence = {
    schemaVersion: "positioncrew.current-block-pinned-evidence.v1",
    evidenceClass: "CURRENT_BLOCK_PINNED",
    chainId: 56,
    source,
    freshnessAtCreation: "FRESH",
    evaluatedAt: createdAt,
    maxDataAgeSeconds: request.maxDataAgeSeconds,
    lpLiveMatchAudition: audition,
  };
  const evidenceHash = await sha256Commitment(evidence);
  const selection = selectLpLiveMatchProvider(audition, {
    schemaVersion: "positioncrew.lp-live-match-selection-request.v1",
    selectedProvider: "HEYANON",
    auditionHash: evidenceHash,
  }, evidenceHash, new Date(startedAt));
  const response = await runCurrentBlockPinnedProviderDeliverable(request, {
    ...baseline.result.deliverable,
    requestId: request.requestId,
    status: "REFUSED_INCONSISTENT_DATA",
    decision: "NONE",
    summary: "The selected LP provider could not safely complete this exact job; no fallback provider was used.",
    generatedAt: completedAt,
    expiresAt: request.deadline,
    proposedRange: null,
    actionSteps: [],
    estimatedRebalanceCostUsd: "0",
    expectedGrossFeesUsd: "0",
    expectedNetBenefitUsd: "0",
    breakEvenHours: null,
    inventoryExposure: { token0Bps: request.position.token0ShareBps, token1Bps: request.position.token1ShareBps },
    invalidationConditions: ["Create a new block-pinned audition before trying another provider."],
    limitations: [detail, "No approval, signature, payment, or liquidity transaction occurred."],
  }, new Date(completedAt), { providerId: selection.providerId });
  const deliverableHash = response.result.job.deliverable?.deliverableHash;
  if (!deliverableHash) throw new Error("Sealed LP recovery result has no deliverable commitment");
  response.liveMatchExecution = LpLiveMatchExecutionSchema.parse({
    schemaVersion: "positioncrew.lp-live-match-execution.v1",
    outcome: "REFUSED",
    selection,
    invocation: { startedAt, completedAt, endpoint: selection.endpoint, latencyMilliseconds: waitMilliseconds,
      rawResponseHash: null, normalizedResponseHash: deliverableHash,
      checks: [{ code, status: "FAIL", detail }] },
    source: { hireId, jobId, requestHash, evidenceHash, ...source },
    commerce: { directCostUsd: "0.00", payment: "NONE", settlement: "NONE", walletRequired: false },
    claimBoundary: [
      "UI recovery fixture only; the selected provider was not invoked.",
      "The saved request, audition and selected provider remain bound together.",
      "No payment, provider substitution or chain transaction occurred.",
    ],
  });
  response.receipt = { ...response.receipt, mode: "SESSION_EMBEDDED", path: `/api/benchmark-receipts/${receiptId}` };
  const [benchmarkSlug, task] = freshMarketplaceTaskForService("LP_REBALANCE")!;
  const chain = {
    schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
    hire: { hireId, service: "LP_REBALANCE", benchmarkSlug, providerSlug: task.providerSlug,
      providerId: selection.providerId, request, requestHash, evidenceHash,
      evidenceMode: "CURRENT_BLOCK_PINNED", createdAt,
      evidence },
    job: { jobId, state: "COMPLETED", status: "COMPLETED", createdAt, startedAt, completedAt,
      apiDurationMilliseconds: waitMilliseconds, error: null,
      providerSelection: selection, providerSelectionHash: await sha256Commitment(selection) },
    receipt: { receiptId, publicUrl: `/api/benchmark-receipts/${receiptId}`, createdAt: completedAt,
      responseHash: await sha256Commitment(response), deliverableHash,
      evaluationHash: response.result.evaluation.evaluationHash, response },
  };
  expect(await isFreshMarketplaceChainForReference(chain, {
    hireId, service: "LP_REBALANCE", rememberedAt: createdAt,
  }), "Saved LP refusal fixture must pass the unchanged public hydration validator").toBe(true);
  return chain;
}

for (const scenario of [
  {
    name: "bounded delivery deadline",
    code: "LP_DELIVERY_DEADLINE",
    detail: "PositionCrew's LP delivery deadline expired after 2500 ms; the external invocation did not complete.",
    waitMilliseconds: 2_500,
    visibleReason: "The job's bounded delivery wait timed out after 2.5 seconds.",
  },
  {
    name: "historical 8-second MCP timeout",
    code: "HEYANON_MCP_LOCAL_TIMEOUT",
    detail: "[HEYANON_MCP_LOCAL_TIMEOUT] HeyAnon MCP getCurrentPoolPrice FETCH: the local 8000 ms deadline expired.",
    waitMilliseconds: 8_000,
    visibleReason: "Waiting for the selected provider's pool-price check timed out after 8 seconds.",
  },
]) {
  test(`expired saved LP ${scenario.name} retains its cause alongside expiry after reload`, async ({ page }) => {
    const chain = await savedLpRefusal(scenario.code, scenario.detail, scenario.waitMilliseconds);
    await page.clock.install({ time: new Date(Date.parse(chain.hire.request.deadline) + 60_000) });
    await page.addInitScript(({ key, id, rememberedAt }) => {
      localStorage.setItem(key, JSON.stringify({ schemaVersion: key, entries: [{
        hireId: id, service: "LP_REBALANCE", rememberedAt,
      }] }));
    }, { key: historyKey, id: hireId, rememberedAt: chain.hire.createdAt });
    let savedReads = 0;
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && request.url().includes("/api/benchmark-hires")) {
        mutations.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.route(`**/api/benchmark-hires/${hireId}`, (route) => {
      savedReads += 1;
      return route.fulfill({ json: chain });
    });
    await page.goto("/#jobs");

    for (const reopen of [false, true]) {
      if (reopen) await page.reload();
      const panel = page.getByTestId("recent-jobs-device");
      await panel.getByRole("button", { name: "Open result", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Refresh evidence before acting", exact: true })).toBeVisible();
      await expect(page.getByText("This result has expired.", { exact: true })).toBeVisible();
      const failure = page.getByRole("region", { name: "Selected provider failure" });
      await expect(failure).toBeVisible();
      await expect(failure.getByRole("heading", { name: "Why this hire was refused" })).toBeVisible();
      await expect(failure).toContainText(scenario.visibleReason);
      await expect(failure).toContainText("No fallback provider was used. No payment or liquidity transaction occurred.");
      await expect(page.getByRole("heading", { name: "Request conditions and recovery", exact: true })).toBeVisible();
      await expect(failure.locator("svg.lucide-check")).toHaveCount(0);
    }

    expect(savedReads).toBeGreaterThanOrEqual(2);
    expect(mutations).toEqual([]);
  });
}
