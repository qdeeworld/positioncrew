# Historical founder benchmark: quality reassessment

Assessment date: 2026-09-05.

This is a later, separate automated arithmetic assessment of the retained August 20 founder comparisons. It did not invoke the strategy generator or conformance evaluator. It is not independent human evaluation, a new paired benchmark, or a replacement for the original frozen rubric. Original requests, answers, timestamps, quality method, scores and hashes remain unchanged.

## What the original report establishes

The [original founder report](https://positioncrew.dolepee.com/evidence/agent-advantage-founder/) retains three manual outputs, three marketplace-hired agent outputs, recorded times, direct costs and exact canonical output parity. Founder operation and non-blindness are disclosed. The comparisons used synthetic frozen fixtures, not documented observations of the placeholder wallets and markets.

| Case | Recorded human duration | Recorded agent API duration | Recorded direct costs |
| --- | --- | --- | --- |
| Lending | 356626 ms | 371 ms | $0 / $0 |
| LP | 94612 ms | 381 ms | $0 / $0 |
| Grid | 28834 ms | 359 ms | $0 / $0 |

Human task time and server processing time have different boundaries. These figures are not a controlled end-to-end speedup. Modeled gas, trading fees or profit inside an answer are not costs or returns actually incurred by these comparisons.

Exact parity means the two recorded answers match. It does not independently establish financial correctness or useful economic advantage. The findings below therefore apply equally to both matching answers; they are not new comparative scores.

## Lending: arithmetic reproduces under the supplied assumptions

The retained input gives $960 liquidation-weighted collateral and $920 debt: `960 / 920 = 1.04347826`. Its stress reduces weighted collateral to $864: `864 / 920 = 0.93913043`. Repaying $152 leaves $768 debt and produces `960 / 768 = 1.25`. The $237.50 collateral alternative also reproduces under the supplied price and collateral factor.

The repayment would produce a health factor of `864 / 768 = 1.125` under that stress. The retained answer does not expressly promise that its 1.25 target is met after stress, so this is a limitation rather than an additional demonstrated contract violation. None of these calculations establishes authentic borrower or oracle provenance for the placeholder input.

## LP: notional limits and fixture consistency are not established

The retained case describes a $10,000 position, a $250 maximum action, a shift from 100% token0 to 50/50, and whole-position instructions without a partial size. A roughly $5,000 allocation change would be 20 times the cap under the ordinary notional interpretation. The answer therefore does not demonstrate compliance with that cap; transaction-level sizing is absent.

Under standard V3 conventions, tick 150 implies token1/token0 of approximately 1.0151123, while the fixture's stated USDT/WBNB prices imply 1/600. The above-range original position is also labeled 100% token0. The stated 50/50 proposed inventory does not follow from the supplied ticks. These are inconsistencies in a synthetic case, not observations of a real LP loss.

Some accounting identities reproduce: `$0.05 + $0.95 = $1`, `$19 - $1 = $18`, and `24 / 19 = 1.2631579 hours`. They do not substantiate the $19 fee forecast or prove that a real rebalance would earn the reported benefit.

## Grid: accounting is not an enforced inventory or loss bound

The answer's arithmetic `250 - 60 - 20 - 1 = 169` reproduces. Its fees and slippage imply $20,000 turnover, but the cycle definition needed to justify the turnover and gross spread is not established by the retained payload.

A conditional inventory counterexample fits the stated $1,000 capital: the sell orders require approximately 46.536796536795 base units, worth $465.37 at the initial price of 10. Holding those units plus $500 cash costs about $965.37. If the first buy at 9.5 fills before the sells, inventory becomes approximately $692.10, above the $600 cap and the claimed $500 maximum. Actual opening holdings and enforceable pre-fill controls are not established, so this is a feasible counterexample to the claimed bound, not a measured trading event.

The buys can spend approximately $500. Cancelling remaining orders does not liquidate acquired inventory. The payload does not establish either its $131 worst-case loss or enforcement of the $150 loss limit under further adverse price movement. No actual loss is asserted.

## Separate production evidence, not replacement pairs

These later public receipts show narrower service behavior. They must not be retroactively paired with the original synthetic manual answers or presented as unrelated customer demand:

- [LP receipt](https://positioncrew.dolepee.com/api/benchmark-receipts/055fa0d8-e195-417e-90fc-4a5c2ec2b22d): actual PancakeSwap position 1456267 at block 120177489; explicit first-party selection, fresh assessment and HOLD. Requester ownership is not established. The external verification failure is retained.
- [Lending receipt](https://positioncrew.dolepee.com/api/benchmark-receipts/30a39201-e830-4a5e-9ea8-259ec50e4565): zero-address empty-position refusal. This is a refusal smoke test, not a rescued borrower.
- [Yield receipt](https://positioncrew.dolepee.com/api/benchmark-receipts/1bf9bcdf-7b4b-4c10-bab6-91cb36005882): observed Venus markets with an assumed, unfunded $1,000 allocation scenario. This is conditional planning, not a funded supply or realized return.
- [Grid receipt](https://positioncrew.dolepee.com/api/benchmark-receipts/cdc19ff7-ad33-4b4f-8a3e-23f33f578324): observed PancakeSwap market with assumed $1,000 capital; NO_GRID. It is not executed trading.

These jobs completed inside their recorded evidence windows, but their snapshots are now historical. They cost $0, used no wallet or payment, and produced unsigned assessments. Server-bound observations are not a claim that execution independently re-fetched every chain value. Embedded TEST_USDC and memory-funding entries are simulation bookkeeping, not settlement.

Separate offline agent runs also exist as research. Without a corresponding marketplace hire they are not a completed marketplace-hired comparison, and they supply no missing human work.

## Reporting boundary

The [TermiX requirements](https://www.agent.family/campaigns/bnb-build-the-era) ask for three real tasks with and without a marketplace-hired agent, time, cost, quality and actual outputs, including a trading, equities or security task. They do not make an unrelated manual operator or blind evaluator mandatory.

This reassessment does not settle how the organizers will classify the original synthetic cases. It preserves completed founder work while identifying provenance and quality limitations. It does not claim automatic eligibility, disqualification, corrected historical outputs, independent adoption, or a demonstrated agent advantage on new real cases.
