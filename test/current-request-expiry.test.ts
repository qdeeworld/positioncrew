import { describe, expect, it } from "vitest";
import { currentHireErrorMessage, currentRequestNeedsRefresh, isCurrentHireRefreshError } from "../web/src/current-request-expiry.js";

const now = Date.parse("2026-09-08T03:00:00.000Z");
const iso = (offset: number) => new Date(now + offset).toISOString();
const request = { deadline: iso(300_000), maxDataAgeSeconds: 120 };
const observation = { observedAt: iso(-5_000), binding: { expiresAt: iso(120_000) } };

describe("current request UI freshness", () => {
  it("allows a complete fresh request", () => {
    expect(currentRequestNeedsRefresh(request, observation, now)).toBe(false);
  });
  it.each([
    ["request deadline", { ...request, deadline: iso(10_000) }, observation, 10_000],
    ["observed-state age", request, observation, 115_000],
    ["signed expiry", request, { ...observation, binding: { expiresAt: iso(15_000) } }, 15_000],
  ] as const)("expires at the earliest %s, including equality", (_name, input, source, offset) => {
    expect(currentRequestNeedsRefresh(input, source, now + offset - 1)).toBe(false);
    expect(currentRequestNeedsRefresh(input, source, now + offset)).toBe(true);
  });
  it.each([null, undefined, { ...observation, binding: undefined }, { ...observation, binding: null },
    { ...observation, observedAt: "invalid" }, { ...observation, binding: { expiresAt: "invalid" } },
  ])("fails closed for missing or malformed observation %j", (source) => {
    expect(currentRequestNeedsRefresh(request, source, now)).toBe(true);
  });
  it.each([null, undefined, { ...request, deadline: "invalid" }, { ...request, maxDataAgeSeconds: -1 },
    { ...request, maxDataAgeSeconds: "120" }, { ...request, maxDataAgeSeconds: Infinity },
    { ...request, maxDataAgeSeconds: NaN }, { ...request, maxDataAgeSeconds: Number.MAX_VALUE },
  ])("fails closed for missing or malformed request %j", (input) => {
    expect(currentRequestNeedsRefresh(input, observation, now)).toBe(true);
  });
  it("rejects an invalid clock", () => {
    expect(currentRequestNeedsRefresh(request, observation, NaN)).toBe(true);
  });
  it("fresh evidence can replace an expired request without mutating it", () => {
    const future = now + 600_000;
    expect(currentRequestNeedsRefresh(request, observation, future)).toBe(true);
    const nextRequest = { ...request, deadline: iso(900_000) };
    const nextObservation = { observedAt: iso(600_000), binding: { expiresAt: iso(720_000) } };
    expect(currentRequestNeedsRefresh(nextRequest, nextObservation, future)).toBe(false);
    expect(currentRequestNeedsRefresh(request, observation, future)).toBe(true);
  });
});

describe("refresh error presentation", () => {
  it("turns a truncated API envelope into actionable text", () => {
    const raw = '409 : {"error":"REFRESH_REQUIRED","details":["This server observation has expired. Reload the market';
    expect(isCurrentHireRefreshError(raw)).toBe(true);
    expect(currentHireErrorMessage(raw)).toContain("Refresh the position or market above");
    expect(currentHireErrorMessage(raw)).not.toContain("409");
    expect(currentHireErrorMessage(raw)).toContain("recorded job is retained");
  });
  it("does not hide unrelated errors", () => {
    expect(isCurrentHireRefreshError(null)).toBe(false);
    expect(isCurrentHireRefreshError("Request timed out")).toBe(false);
    expect(currentHireErrorMessage("Request timed out")).toBe("Request timed out");
  });
});
