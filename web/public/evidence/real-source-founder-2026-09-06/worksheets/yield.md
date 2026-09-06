# Final manual task: assess a yield allocation

## Start

Start your stopwatch before reading further. Include reading, calculations, writing, corrections and interruptions. Report early access honestly.

Use a calculator, spreadsheet and protocol documentation, not AI or the marketplace/provider answer. These AI-prepared instructions describe the existing study model; they do not supply your calculations or decision. No wallet, payment, transaction or JSON is required.

## The question

Under the frozen facts and limits below, is there an eligible allocation worth making after costs? Name the destination and bounded amount, or hold/refuse with the controlling reason. Explain the arithmetic, assumptions and what remains unknown.

The market observations are real. The $1,000 budget is hypothetical. No owned balance, existing funded portfolio, deposit, execution permission or realised return is established. Do not describe a scenario recommendation as an executable funded action.

## Frozen source

- Network: BNB Smart Chain, chain ID 56.
- Protocol: Venus Core Pool stablecoin supply.
- Block: 120272332.
- Observed: September 6, 2026, 08:41:51 UTC.
- Request time: 08:41:53.233 UTC.
- Request deadline: 08:43:53.233 UTC.
- Snapshot binding expiry: 08:43:51 UTC.
- Maximum data age: 120 seconds.
- Account field: 0x0000000000000000000000000000000000000000. This is not evidence of a funded wallet.
- Current positions supplied: none.

Assess the original frozen window retrospectively. Do not refresh or replace the observations, backdate your work, or treat expired data as usable for a transaction now.

## Opportunities as supplied

All opportunities are on Venus Core Pool. All assets have 18 decimals. Each row's supplied amountUsd is $1,000; the rows share one total $1,000 budget, not $4,000.

| Opportunity ID | Asset | Gross annual rate, basis points | Available market liquidity USD | Lockup seconds | Risk tier | Entry cost USD | Exit cost USD |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| venus-core-usdt-supply | USDT | 275 | 63183613.03 | 0 | MEDIUM | 0.013228 | 0.013228 |
| venus-core-fdusd-supply | FDUSD | 248 | 2987723.55 | 0 | MEDIUM | 0.013228 | 0.013228 |
| venus-core-usdc-supply | USDC | 207 | 20619111.88 | 0 | MEDIUM | 0.013228 | 0.013228 |
| venus-core-dai-supply | DAI | 183 | 1017009.39 | 0 | MEDIUM | 0.013228 | 0.013228 |

Markets: USDT 0xfD5840Cd36d94D7229439859C0112a4185BC0255; FDUSD 0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba; USDC 0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8; DAI 0x334b3eCB4DCa3593BCCC3c7EBD1A1C1d1780FBF1.

## Buyer limits

- Hypothetical capital: $1000.00.
- Maximum action principal: $1000.00.
- Maximum allocation: $1000.00.
- Maximum execution cost: $0.250000.
- Maximum gas: $0.250000.
- Maximum slippage: zero. No swap permission is supplied.
- Allowed protocol: Venus Core Pool only.
- Maximum risk tier: MEDIUM.
- Maximum exposure to one protocol: 100% of capital, aggregated across that protocol's opportunities.
- Maximum lockup: zero seconds.
- Minimum market liquidity: $100000.
- Minimum net benefit: $1.
- Evaluation horizon: 90 days.

## Existing study model and boundaries

One basis point is 0.01 percentage points. Convert an annual rate in basis points to a decimal by dividing by 10,000.

Projected gross yield = allocation USD * (annual rate in basis points / 10000) * (90 / 365).

This simple model holds rates constant, uses a 365-day year, and does not compound. The request names the rate field grossApyBps, but this projection is not a compounded APY calculation or guaranteed future performance.

Subtract selected entry costs and any used-source exit costs once. No current positions are supplied, so do not invent an existing source position or its withdrawal costs. A later exit from the destination is not automatically included in the study's entry-horizon net benefit: disclose that boundary. You may additionally show an exit-inclusive scenario if clearly separated and explained.

Relevant selected entry and used-source exit costs must fit the execution/gas ceiling. Where a separate gas breakdown is absent, apply the entire relevant cost quote to that ceiling, rather than assume gas is zero.

Any funding must be conditional on disclosed idle capital or supplied same-asset unlocked positions. The scenario budget is not a verified token balance. Do not invent a swap, loan, wallet holding or withdrawal authority. Explain what asset availability would be required for your proposal.

Allocation and aggregate principal withdrawn must EACH fit the principal limits; do not count moving the same principal as two independent spending authorizations. Preserve funds and aggregate final protocol exposure. A feasible choice is not automatically a globally optimal one.

The model does not price changing rates, depeg, smart-contract loss, execution failures or all future costs. Identify assumptions instead of claiming a guaranteed profit.

## Work order

1. Check each opportunity against protocol, risk, liquidity and lockup limits.
2. Calculate the relevant 90-day benefit after costs for the candidate amounts you consider. Include enough work to justify your choice, not just a quoted rate.
3. Check total allocation, costs, gas, concentration and funding assumptions.
4. Return a bounded scenario allocation, hold, refusal or inability with reasons.
5. Explain what must be verified before a real deposit.

## Your original answer

Name and relationship to PositionCrew:Iyanda Abdulqodir /Founder

Prior exposure to this exact task's agent answer and any related earlier results:no

Eligible or ineligible opportunities, with reasons:All four are eligible because they are all on Venus Core Pool, medium risk, have no lockup and have more than the minimum $100,000 liquidity.

My calculations of projected gross benefit, costs and net benefit:USDT gives about $6.78 gross for 90 days on $1,000. After the $0.013228 entry cost, it is about $6.77 net.
FDUSD is about $6.10 net.
USDC is about $5.09 net.
DAI is about $4.50 net.

My decision (scenario allocation / hold / refuse / unable to determine):Scenario allocation

Chosen destination and amount, if applicable; otherwise why not applicable:$1,000 to Venus Core Pool USDT, but only if $1,000 USDT is actually available.

Why I chose this result:USDT gives the highest return from the four options and the expected benefit is above the required $1 minimum.

Principal, execution cost, gas, concentration and other limits checked:The $1,000 amount is within the $1,000 limit. The $0.013228 cost is below the $0.25 limit. Risk is medium, there is no lockup, liquidity is above $100,000 and putting 100% into Venus is allowed. No swap is needed.

Required funding asset, assumptions and unresolved facts:The $1,000 is only a hypothetical amount. There is no proof that the wallet actually has $1,000 USDT or that I have permission to use the funds.

What the projection excludes and what must be checked before an actual deposit:The calculation assumes the rate stays the same for 90 days. It doesn't guarantee profit and doesn't cover things like changing rates, depeg or smart contract risk. Before any real deposit, the rate, liquidity, gas, wallet balance, protocol state and authority to use the funds need to be checked again

Tools/documentation actually used:calculator and excel

Actual direct expense paid, currency or unknown:zero

Actual stopwatch elapsed time:45 minutes

Actual start/end date, time, AM/PM and timezone if recorded:9:09-9:59 WAT

Interruptions, early reading, errors or help received:none

## Finish

Stop the stopwatch when your answer is complete. Return the original answer and elapsed time without first viewing the agent answer. Later corrections will be preserved separately.

This manual elapsed time includes reading and reasoning; the existing automated timing measures delivery latency. We will not claim a controlled end-to-end speedup from those different boundaries. Scoring will be disclosed as AI-assisted, not an independent human evaluation.
