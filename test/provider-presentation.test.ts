import { describe, expect, it } from "vitest";
import { identityNetworkLabel, selectedProviderFailureMessage } from "../web/src/provider-presentation.js";

describe("selected provider failure presentation", () => {
  it("explains the recorded pool-price timeout instead of generic recovery conditions", () => {
    const result = selectedProviderFailureMessage({
      outcome: "REFUSED",
      invocation: { checks: [{
        code: "HEYANON_MCP_LOCAL_TIMEOUT", status: "FAIL",
        detail: "[HEYANON_MCP_LOCAL_TIMEOUT] HeyAnon MCP getCurrentPoolPrice FETCH: the local 8000 ms deadline expired.",
      }] },
    }, ["Create a new block-pinned audition before trying another provider."]);
    expect(result).toBe("Waiting for the selected provider's pool-price check timed out after 8 seconds. Refresh the comparison and try again.");
    expect(result).not.toContain("expired");
  });

  it("explains changed terms without blaming subsequent snapshot expiry", () => {
    expect(selectedProviderFailureMessage({
      outcome: "REFUSED", invocation: { checks: [
        { code: "NORMALIZED_EVIDENCE_GATE", status: "PASS", detail: "Fresh at delivery." },
        { code: "AUDITION_RESULT_STABLE", status: "FAIL", detail: "Material terms changed." },
      ] },
    })).toBe("The selected provider changed its assessment after you chose it. Refresh the comparison and choose a provider again.");
  });

  it("uses the known timeout limitation when an older execution lacks checks", () => {
    expect(selectedProviderFailureMessage({ outcome: "REFUSED" }, [
      "[HEYANON_MCP_LOCAL_TIMEOUT] HeyAnon MCP getCurrentPoolPrice FETCH: the local 8000 ms deadline expired.",
    ])).toContain("pool-price check timed out after 8 seconds");
  });

  it("uses a known changed-response limitation without inventing a timeout", () => {
    expect(selectedProviderFailureMessage({ outcome: "REFUSED" }, [
      "The external provider response changed after the buyer selected it.",
    ])).toContain("changed its assessment");
  });

  it("does not display arbitrary upstream diagnostics or implausible timeout durations", () => {
    const result = selectedProviderFailureMessage({ outcome: "REFUSED", invocation: { checks: [{
      code: "HEYANON_MCP_LOCAL_TIMEOUT", status: "FAIL",
      detail: "https://provider.invalid/?secret=do-not-display local 999999 ms deadline expired",
    }] } });
    expect(result).toContain("response timed out");
    expect(result).not.toContain("secret");
    expect(result).not.toContain("999999");
  });

  it("does not let a historical limitation override the actual failed check", () => {
    expect(selectedProviderFailureMessage({ outcome: "REFUSED", invocation: { checks: [{
      code: "RANGE_WIDTH_POLICY", status: "FAIL", detail: "The width exceeds the buyer cap.",
    }] } }, ["[HEYANON_MCP_LOCAL_TIMEOUT] local 8000 ms deadline expired"])).toContain("does not fit your width limits");
  });

  it("does not present successful delivery or missing execution as a provider failure", () => {
    expect(selectedProviderFailureMessage({ outcome: "DELIVERED" })).toBeNull();
    expect(selectedProviderFailureMessage(undefined)).toBeNull();
  });

  it("keeps unknown failure diagnostics in the receipt", () => {
    const result = selectedProviderFailureMessage({ outcome: "REFUSED", invocation: { checks: [{
      code: "UNKNOWN_FAILURE", status: "FAIL", detail: "<script>secret</script> https://private.invalid/token",
    }] } });
    expect(result).toContain("Open the receipt for the recorded failure");
    expect(result).not.toContain("secret");
    expect(result).not.toContain("private.invalid");
  });
});

describe("provider registration network labels", () => {
  it("keeps the actual testnet registration separate from mainnet observations", () => {
    expect(identityNetworkLabel("https://testnet.bscscan.com/token/0x123?a=1811")).toBe("BSC testnet");
    expect(identityNetworkLabel("https://bscscan.com/token/0x123?a=45650")).toBe("BSC mainnet");
  });

  it.each([
    "https://testnet.bscscan.com.evil.invalid/token/1811",
    "http://testnet.bscscan.com/token/1811",
    "https://unrelated.invalid/token/1811",
    "not a URL",
  ])("does not infer a verified network from %s", (url) => {
    expect(identityNetworkLabel(url)).toBe("Network not established");
  });
});
