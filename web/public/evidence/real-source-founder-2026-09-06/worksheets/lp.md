# LP task: is changing the range worth it?

## Start

Start your stopwatch before reading the task. Keep reading, calculation, writing, corrections and interruptions inside the elapsed time. If you read early, report it honestly.

Use a calculator, spreadsheet or protocol documentation, not an AI assistant or provider answer. These AI-prepared instructions provide the study's existing model, not the decision. Your answer and calculations must be your own. No wallet, payment, transaction or JSON is required.

## Your job

Assess this real PancakeSwap V3 position at the frozen block. Should it keep its range, move to a bounded new range, or refuse because the evidence or limits do not support a recommendation?

Explain the economics and constraints. If proposing a move, state the range, size and assumptions. If you cannot establish a safe or worthwhile move, explain what is missing. Do not invent evidence to complete the answer.

This is retrospective analysis, not current investment advice. Do not reload today's position or replace the snapshot. The recorded account is public; ownership and authority are not established.

## Frozen source

- Chain: BNB Smart Chain, 56.
- PancakeSwap V3 NFT: 1456267.
- Account: 0x556B9306565093C855AEA9AE92A594704c2Cd59e.
- Pool: 0x36696169C63e42cd08ce11f5deeBbCeBae652050.
- Block: 120272319.
- Observed: September 6, 2026, 08:41:45 UTC.
- Request time: 08:41:48.057 UTC.
- Request deadline: 08:43:48.057 UTC.
- Snapshot binding expired: 08:43:45 UTC.
- Maximum data age: 120 seconds. Do not backdate your work or treat this snapshot as executable now.

## Position and market facts

| Input | Value |
| --- | --- |
| Token 0 | USDT, 18 decimals |
| Token 1 | WBNB, 18 decimals |
| Lower tick | -68150 |
| Upper tick | -63690 |
| Current tick | -66281 |
| Position liquidity units | 612955555285030311979 |
| Position value | $3550.911984 |
| Fees already earned | $18.266638 |
| Current USDT value share | 57.64% |
| Current WBNB value share | 42.36% |
| USDT price | $1.00007130 |
| WBNB price | $755.77009450 |
| Pool dollar liquidity | $125755279.66 |
| Normalized daily volume | $9652558.26 |
| Normalized daily pool fees | $4826.28 |
| Realized volatility | 61 basis points |
| Actual measurement window | 3602 seconds |
| Normalization factor | 23.986674 |
| Swaps in measurement window | 622 |

The daily figures extrapolate a shorter observed window. They are not a directly observed full day or guaranteed future earnings. Fees already earned are not additional future rebalance benefit.

## Buyer limits and estimates

| Constraint | Value |
| --- | --- |
| Minimum range width | 2230 ticks |
| Maximum range width | 13380 ticks |
| Tick spacing | 10 |
| Near-edge buffer | 1000 basis points (10% of range width) |
| High-volatility threshold | 1000 basis points |
| Maximum USDT value share | 75% |
| Maximum WBNB value share | 75% |
| Maximum action USD field | $1.956321 |
| Maximum gas | $0.250000 |
| Estimated gas | $0.028341 |
| Estimated swap cost | $0.949819 |
| Maximum slippage | 30 basis points (0.30%) |
| Minimum net benefit | $3.550912 |
| Evaluation horizon | 24 hours |

Preserve every limit. Position value is not permission to spend or move it. If the action-budget meaning or any required input is insufficient for your proposal, state that rather than silently enlarging authority.

## Definitions and the study's existing model

A tick identifies a price boundary. For the existing range, lowerTick <= currentTick < upperTick means in range. Width is upperTick minus lowerTick. A proposed range must have valid ordered endpoints aligned to tick spacing and a final width within both limits.

Nearest-edge distance is the smaller of currentTick minus lowerTick and upperTick minus currentTick for an in-range position. The policy calls it near-edge when floor(10000 * nearest-edge distance / width) is below edgeBufferBps.

The supplied screening model uses:

feeBase = daily pool fees * (position dollar value / pool dollar liquidity) * (horizon hours / 24).

Estimated current-range fees = feeBase * current fee-uptime factor.

Choose the factor using this existing policy, in order:

- Out of range: 0%.
- Otherwise near-edge: 35%.
- Otherwise volatility at or above the high-volatility threshold: 55%.
- Otherwise: 90%.

These percentages are assumptions, not measured future uptime. Dollar pool share is not exact active V3 fee entitlement. Apply the supplied daily fee figure once; do not multiply by the normalization factor again.

The model holds prices, position value, pool liquidity and fee run-rate constant, with linear accrual and no compounding. It does not establish future price movement, impermanent loss or execution failures.

For a proposed move, explain its forecast assumptions and compare incremental projected benefit after relevant costs with the minimum net benefit. Do not count all future fees as incremental benefit, invent an unexplained forecast, or assume a new range has the current inventory split. A new range needs its own inventory and size checks. A no-move result can show modeled current-range fees but has no incremental rebalance benefit or rebalance transaction cost.

## Suggested work order

1. Calculate current width, in-range status and distance from the nearest edge.
2. Select the applicable current-range model factor and calculate its projected fees, stating assumptions.
3. Assess whether any proposed change is justified after costs and limits. Do not force a move merely because another range is possible.
4. Give your decision and supporting calculations. For a move, include proposed ticks, size, inventory and budget checks. Otherwise explain why those are not applicable or not established.
5. Explain what must be refreshed and verified before any transaction.

## Your original answer

Name and relationship to PositionCrew:Iyanda Abdulqodir/builder

Prior exposure to this task, its agent answer or related earlier results:no

Current width, in-range status and nearest-edge calculation:Width is 4,460 ticks. Current tick is inside the range. Nearest edge is 1,869 ticks away, about 4,190 bps, so it is not near the edge.

Applicable model factor and why:90%, because the position is still in range, not near the edge, and volatility is only 61 bps, below the 1,000 bps high-volatility level.

Projected current-range fees, calculation and assumptions:Using the supplied formula gives roughly $0.12 for 24 hours

My decision (keep range / move / refuse / unable to determine):Keep the current range

Why, including incremental benefit and costs where applicable:The position is still in range and not close to the edge. I could not establish that moving it would provide enough extra benefit after costs to meet the required $3.550912 minimum net benefit.

If moving: new ticks, size, forecast assumptions and final inventory. Otherwise why not applicable or not established:No new range or amount applies because there isn't enough evidence to justify a move. The $1.956321 maximum action amount also doesn't establish permission to move the $3,550 position.

Limits checked, failed conditions and missing facts:Estimated gas of $0.028341 is below the $0.25 limit. Swap cost is about $0.95, slippage cannot exceed 0.30%, either token cannot exceed 75% of value, and the required minimum net benefit is $3.550912. The snapshot is also already expired and wallet/NFT authority isn't established.

What must be checked again before a real transaction:Refresh the position, tick, prices, liquidity, fees, volatility, gas, slippage, balances and confirm authority to use the NFT

Tools/documentation actually used:calculator, spreadsheet/excel 

Direct expense paid, currency or unknown:zero

Actual stopwatch elapsed time:57 minutes

Actual start/end date, time and timezone if recorded:8:02 - 8:59 was

Interruptions, early reading, errors or help received:none

## Finish

Stop the stopwatch when your answer is finished and return the original answer. Do not open the agent result first. Later corrections will be retained separately.

Your complete manual-task time and the earlier automated delivery latency have different measurement boundaries. They will not be presented as a controlled end-to-end speedup.
