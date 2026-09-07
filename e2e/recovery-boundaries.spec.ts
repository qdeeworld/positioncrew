import { expect, test, type Page } from "@playwright/test";
import { freshMarketplaceTaskForService, sha256Commitment } from "../src/commerce/fresh-hire-schema.js";

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
      providerId: task.providerId, request, requestHash: await sha256Commitment(request),
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
  await expect(page.getByRole("button", { name: "Check my BSC capital", exact: true })).toBeDisabled();
  await nft.fill("");
  await expect(page.getByRole("button", { name: "Check my BSC capital", exact: true })).toBeEnabled();
});

test("capital scan times out even when only the response body stalls", async ({ page }) => {
  await page.clock.install();
  await stallBody(page, "capital");
  await page.goto("/#marketplace");
  await page.locator(".capital-check-form input").first().fill("0x0000000000000000000000000000000000000001");
  await page.getByRole("button", { name: "Check my BSC capital", exact: true }).click();
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
