"""Recheck frozen September 6 arithmetic without importing provider code.

This checks specific calculations and preserves source fingerprints. It does not
score prose, establish independent human judgment, or repair unequal timing.
Run with --write to regenerate the separately dated verification attachment.
"""
from pathlib import Path
from decimal import Decimal, localcontext, ROUND_DOWN
import argparse
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "web/public/evidence/real-source-founder-2026-09-06"
OUTPUT = BASE / "verification-2026-09-09.json"
D = Decimal


def build():
    paths = sorted(p for p in BASE.rglob("*") if p.is_file() and p != OUTPUT)
    fingerprints = {str(p.relative_to(BASE)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    requests = {task: json.loads((BASE / f"agent/{task}/inputs/request.json").read_text()) for task in ("lending", "lp", "yield")}
    outputs = {task: json.loads((BASE / f"agent/{task}/deliverable.json").read_text()) for task in requests}
    checks = []

    def check(name, condition):
        checks.append({"name": name, "passed": bool(condition)})

    def close(actual, expected, tolerance="0.000001"):
        return abs(D(actual) - expected) <= D(tolerance)

    def number(value):
        return format(value.quantize(D("0.000000000001"), rounding=ROUND_DOWN), "f")

    for task in requests:
        check(f"{task}: output belongs to frozen request", outputs[task]["requestId"] == requests[task]["requestId"])

    with localcontext() as ctx:
        ctx.prec = 70
        req, result = requests["lending"], outputs["lending"]
        assets = [a for a in req["position"]["collateral"] if a["collateralEnabled"]]
        collateral = sum(D(a["amount"]) * D(a["priceUsd"]) for a in assets)
        weighted = sum(D(a["amount"]) * D(a["priceUsd"]) * D(a["liquidationThresholdBps"]) / 10000 for a in assets)
        debt = sum(D(a["amount"]) * D(a["priceUsd"]) for a in req["position"]["debt"])
        health = weighted / debt
        stressed = health * (1 - D(req["stressPriceDropBps"]) / 10000)
        check("lending: no rescue required by supplied target", health >= D(req["targetHealthFactor"]) and stressed >= D(req["targetHealthFactor"]))
        check("lending: agent returns no action", result["decision"] == "NONE")
        check("lending: agent collateral and debt reproduce", close(result["position"]["collateralValueUsd"], collateral) and close(result["position"]["debtValueUsd"], debt))
        check("lending: agent current and stressed health reproduce", close(result["position"]["currentHealthFactor"], health) and close(result["position"]["stressedHealthFactor"], stressed))
        lending = {"collateralUsd": number(collateral), "weightedCollateralUsd": number(weighted), "debtUsd": number(debt), "health": number(health), "stressedHealth": number(stressed), "humanRoundedValues": {"collateralUsd": "1403.26", "debtUsd": "284.10", "health": "3.57", "stressedHealth": "3.21"}, "comparison": "Both answers reach the supported no-action decision. No quality win assigned; the report retains the agent's 4.284-second invalidation-wording caveat."}

        req, result = requests["lp"], outputs["lp"]
        pos, market, limits = req["position"], req["marketState"], req["constraints"]
        width = pos["upperTick"] - pos["lowerTick"]
        edge = min(market["currentTick"] - pos["lowerTick"], pos["upperTick"] - market["currentTick"])
        edge_bps = edge * 10000 // width
        check("lp: frozen position is in range and outside edge buffer", edge > 0 and edge_bps >= limits["edgeBufferBps"])
        check("lp: supplied low-volatility branch applies", market["realizedVolatilityBps"] < limits["highVolatilityBps"])
        fee_base = D(market["fees24hUsd"]) * D(pos["positionValueUsd"]) / D(market["poolLiquidityUsd"]) * D(limits["evaluationHorizonHours"]) / 24
        current_fees = fee_base * D("0.9")
        move_cost = D(limits["estimatedGasUsd"]) + D(limits["estimatedSwapCostUsd"])
        # This is an upper bound only inside the frozen fixed-share uptime model.
        upper_extra = fee_base - current_fees
        check("lp: agent fee output reproduces at displayed precision", close(result["expectedGrossFeesUsd"], current_fees))
        check("lp: even full uptime cannot cover the quoted move cost in this model", upper_extra < move_cost)
        check("lp: agent reports HOLD without a replacement range", result["decision"] == "HOLD" and result["proposedRange"] is None)
        lp = {"widthTicks": width, "nearestEdgeTicks": edge, "edgeBpsFloor": edge_bps, "feeBaseUsd": number(fee_base), "modeledCurrentFeesUsd": number(current_fees), "maximumExtraFeesWithinFixedShareModelUsd": number(upper_extra), "quotedMoveCostUsd": number(move_cost), "minimumIncrementalNetBenefitUsd": limits["minimumNetBenefitUsd"], "comparison": "Both choose HOLD. The agent explicitly identifies the short-window extrapolation, assumed uptime, fixed share and exclusions. This checks its arithmetic, not exact V3 fee entitlement, realized savings or every possible alternative strategy."}

        req, result = requests["yield"], outputs["yield"]
        capital = D(req["capitalUsd"])
        days = D(req["constraints"]["evaluationHorizonDays"])
        candidates = {o["asset"]["symbol"]: capital * D(o["grossApyBps"]) / 10000 * days / 365 - D(o["estimatedEntryCostUsd"]) for o in req["opportunities"]}
        chosen = next(o for o in req["opportunities"] if o["opportunityId"] == result["selectedOpportunityId"])
        cost = D(chosen["estimatedEntryCostUsd"])
        allocation = capital - cost
        net = allocation * D(chosen["grossApyBps"]) / 10000 * days / 365 - cost
        check("yield: USDT leads the four nominal projections", max(candidates, key=candidates.get) == "USDT")
        check("yield: agent allocation reserves entry cost", D(result["allocationUsd"]) == allocation and D(result["migrationCostUsd"]) == cost)
        check("yield: total agent budget equals supplied capital", D(result["allocationUsd"]) + cost == capital)
        check("yield: agent net projection independently reproduces", close(result["netBenefitUsd"], net, "0.00000000000000001"))
        manual_text = (BASE / "manual/yield/founder-response-original.txt").read_text()
        check("yield: preserved manual response contains nominal allocation and separate fee", "$1,000 to Venus Core Pool USDT" in manual_text and "$0.013228 entry cost" in manual_text)
        yield_result = {"nominalNetAfterEntryUsd": {k: number(v) for k, v in candidates.items()}, "humanStatedAllocationUsd": "1000", "entryCostUsd": str(cost), "humanAllocationPlusEntryUsd": str(capital + cost), "agentAllocationUsd": str(allocation), "agentAllocationPlusEntryUsd": str(allocation + cost), "agentNetAfterEntryUsd": number(net), "comparison": "The manual answer leaves the entry fee's funding unspecified; the agent explicitly reserves it within the hypothetical budget. The difference is $0.013228, not a material realized profit claim. This does not assume a real funded wallet. The historical future-exit exclusion and ambiguous entry/exit step wording remain disclosed."}

    return {"schemaVersion": "positioncrew.real-source-arithmetic-recheck.v1", "reviewDate": "2026-09-09", "captureDate": "2026-09-06", "method": "Python Decimal from original frozen requests; no provider generator, LLM scoring or network calls in this verifier. Retrospective author-operated verification, not an independent human study.", "sourceSha256": fingerprints, "checks": checks, "results": {"lending": lending, "lp": lp, "yield": yield_result}, "claimBoundary": {"newHumanTasks": 0, "newMarketplaceRuns": 0, "timingReconstructed": False, "controlledSpeedupEstablished": False, "independentDemandEstablished": False, "realizedTradingPerformanceEstablished": False, "numericQualityScoreAssigned": False, "originalResponsesChanged": False}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    result = build()
    failures = [c["name"] for c in result["checks"] if not c["passed"]]
    if failures:
        raise SystemExit("Arithmetic recheck failed: " + "; ".join(failures))
    encoded = json.dumps(result, indent=2) + "\n"
    if args.write:
        OUTPUT.write_text(encoded)
    elif not OUTPUT.exists() or OUTPUT.read_text() != encoded:
        raise SystemExit("Verification attachment differs from recomputed values or source fingerprints.")
    print(f"Verified {len(result['checks'])} arithmetic/source checks; no controlled speedup or new human evidence claimed.")
