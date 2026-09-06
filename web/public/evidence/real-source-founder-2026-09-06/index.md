# PositionCrew: three real-source paired assessments

Status: founder-operated paired assessment, scored with disclosed AI assistance. No eligibility or prize guarantee. Entry submission is separate.

## What was compared

Three fixed capital-analysis tasks were performed through PositionCrew's public marketplace and later assessed manually by founder Iyanda Abdulqodir using a calculator or spreadsheet. Both sides used the same frozen numerical inputs and buyer limits. The tasks cover a real Venus borrower, a real PancakeSwap V3 NFT, and real Venus market observations with hypothetical yield principal.

These are analysis tasks, not executed rescue, LP movement, deposit or realised investment performance. The Yield task does not establish an actual funded user portfolio. Lending concerns liquidation-risk assessment; we present that scope rather than calling the study executed trading or an independent security audit.

Agent capture: September 6, 2026, approximately 08:41 UTC, Sites 130, source 35626ba2f35102dc42e442e223044d782169fa07. Current public version 131 does not retroactively change that capture.

Protocol commitment recorded before agent outputs: sha256:0377a35cd3ebbdbae2f3d02a11a0faf85686ebad7ed30a3cace7b82291150dc2. The protocol and captured files remain unchanged, including their historical pending-state fields; this report records subsequent manual completion.

## Method and limits

The prewritten five quality dimensions are decision support, arithmetic, final-state limits, model/observation disclosure, and usability with expiry/uncertainty. Ratings use PASS, FAIL or NOT_ESTABLISHED, not an invented numeric score. No weighted winner or speedup ratio is assigned.

Scoring is AI-assisted and non-blind, using separate Decimal arithmetic from the frozen inputs, not the strategy generator or exact-output matching. It is computationally separate from the generator, not institutionally independent. The assistant also prepared readable worksheets containing the existing formulas and model assumptions. The founder reports performing the answers with calculator/Excel, not AI; this is self-attested, not independently supervised.

The readable worksheets were prepared after the agent runs. They transcribe existing inputs and model definitions but are not themselves pre-output frozen teaching materials. That guidance and preparation asymmetry must remain disclosed. Founder involvement and earlier related product exposure prevent a claim of an independent or blind human benchmark. The founder clarified no prior view of this exact Lending agent answer and reported no prior exposure for the other tasks.

Agent results were delivered in the original freshness windows. Manual work assessed the frozen observations retrospectively. No current financial authority follows from expired observations.

## Time and direct expenditure

| Task | Founder full-task time, self-reported | Automated delivery interval | Server API metric | Recorded direct cost |
| --- | --- | --- | --- | --- |
| Lending | 130 minutes | 3.769761 seconds | 529 ms | Founder reports no paid expense; service $0.00 |
| LP | 57 minutes | 3.929777 seconds | 523 ms | Founder reports zero; service $0.00 |
| Yield | 50 minutes, corrected from 45 | 3.459067 seconds | 508 ms | Founder reports zero; service $0.00 |

Manual time includes reading, calculation and writing. Automated delivery covers frozen-input-ready through create/run/poll and receipt retrieval; it excludes earlier source acquisition and later interpretation, with cognition/preparation/operating overhead unmeasured. Therefore these are separate measurements, NOT a controlled end-to-end speedup. Zero service price and no reported human direct payment do not establish zero infrastructure cost or zero labor cost.

Source acquisition was separately recorded: Lending 5.890911 seconds, LP 1.998987 seconds, Yield 1.239854 seconds. It was shared preparation, not charged only to the human.

Participant confirmed all clock times are PM. Lending: 5:35-7:45 PM; LP: 8:02-8:59 PM WAT; Yield: 9:09-9:59 PM WAT. Lending timezone and calendar dates were not explicitly confirmed. Do not invent absolute human timestamps. Corrections are attached; the original text is preserved.

## Task 1: Venus liquidation-risk assessment

Account 0xe02702687b1653a782af57fbcc56d59b7e99a935 at BSC block 120272302.

Independent arithmetic:
- Collateral: $1403.256925224906...
- Liquidation-weighted collateral: $1013.084653397794...
- Debt: $284.099923921143...
- Current health: 3.565944824677...
- Stressed health: 3.209350342209...
- Target: 1.25.

Founder rounded values agree with this arithmetic. Both sides recommend no action. This is a supported no-rescue conclusion for the supplied snapshot/model, not proof of future safety.

| Dimension | Founder | Agent |
| --- | --- | --- |
| Decision supported | PASS | PASS |
| Material arithmetic | PASS, consistent displayed rounding | PASS, consistent fixed-point precision |
| Applicable final-state limits | PASS for no action | PASS for no action |
| Observation/model boundaries | PASS within supplied retrospective task; revalidation requested | PASS within supplied snapshot assessment |
| Usability, uncertainty and expiry | PASS for retrospective explanation | NOT_ESTABLISHED for fully precise balance-invalidation wording |

Agent caveat: balance invalidation starts at request time 08:41:42.284 rather than observation time 08:41:38, leaving a 4.284-second wording gap. The result separately carries the correct observation and earliest expiry. This study does not establish an actual intervening balance change or unsafe action; the gap remains a qualification, not a manufactured incident.

[Original human answer](manual/lending/founder-response-original.txt) | [Correction](manual/lending/participant-corrections.md) | [Agent output](agent/lending/deliverable.json) | [Frozen request](agent/lending/inputs/request.json) | [Public receipt](https://positioncrew.dolepee.com/api/benchmark-receipts/bbf025cc-c4e7-410e-9c4a-8330ab570a02)

## Task 2: PancakeSwap V3 range assessment

NFT 1456267 at BSC block 120272319.

Width is 4460 ticks; nearest edge is 1869 ticks, or 4190.582959... bps, floored to 4190 by the policy. Position is in range and not near-edge; volatility 61 bps is below the 1000-bps threshold. The supplied policy factor is 90%.

Fee base = $0.136278139068...; modeled current-range fees = $0.122650325161... over 24 hours. The founder's approximately $0.12 and agent's $0.12265 agree. Quoted move costs total $0.978160; minimum incremental net benefit is $3.550912. Both choose HOLD.

| Dimension | Founder | Agent |
| --- | --- | --- |
| Decision supported | PASS: no justified move established | PASS: HOLD under stated screening policy |
| Material arithmetic | PASS | PASS |
| Applicable final-state limits | PASS for no move | PASS for no move |
| Observation/model boundaries | NOT_ESTABLISHED in standalone answer: extrapolation and model exclusions not explained | PASS: policy assumptions, short observation window and exclusions explicit |
| Usability, uncertainty and expiry | PASS: expired data and authority limits noted | PASS within supplied snapshot; expiry and trigger conditions present |

Neither answer proves no conceivable alternate strategy could outperform. No new range is proposed, so this pair does not validate actionable range construction or final rebalanced inventory. The founder correctly avoids treating the position value as spending authority.

[Original human answer](manual/lp/founder-response-original.txt) | [Agent output](agent/lp/deliverable.json) | [Frozen request](agent/lp/inputs/request.json) | [Public receipt](https://positioncrew.dolepee.com/api/benchmark-receipts/57afc631-5e00-4230-a678-ac0b28f1fd38)

## Task 3: Venus yield scenario

BSC market block 120272332; hypothetical $1000 principal, no supplied funded positions. All four opportunities pass the supplied protocol, risk, liquidity and lockup screening. That eligibility is not proof of owned assets or transaction readiness.

At a nominal $1000 allocation, 90-day net projections after entry cost are:
- USDT: $6.767593917808...
- FDUSD: $6.101840493150...
- USDC: $5.090881589041...
- DAI: $4.499100767123...

The founder's rounded figures agree. Both choose USDT, conditional on the study's static-rate model, not a guaranteed return.

Important difference: founder proposes allocating all $1000 and lists the $0.013228 entry cost separately. The answer does not establish how that cost is funded. Total need would be $1000.013228. It may be feasible with separately available fee funds, but those were not supplied. We do not invent them or rewrite the response.

The agent reserves $0.013228, allocates $999.986772, and uses exactly $1000 in its accounting. Its projected net is $6.767504221095... . This is a concrete funding-accounting advantage in this pair, not a general superiority claim.

| Dimension | Founder | Agent |
| --- | --- | --- |
| Decision supported | PASS for conditional USDT scenario choice | PASS for USDT scenario choice |
| Material arithmetic | PASS for nominal $1000 calculations | PASS for fee-reserved allocation calculations |
| Final-state limits and funding | NOT_ESTABLISHED: entry-fee funding missing | PASS within hypothetical capital accounting; actual wallet funding remains unproved |
| Observation/model boundaries | NOT_ESTABLISHED for complete cost disclosure: future exit treatment omitted; variable-rate and ownership caveats present | PASS in study context: model and future exit exclusions explicit |
| Usability, uncertainty and expiry | NOT_ESTABLISHED for fully funded plan; useful conditional recommendation | NOT_ESTABLISHED as a standalone wallet-ready result: surrounding study must supply hypothetical-capital/authority boundary |

The agent's ACTIONABLE status denotes an assessment output, not wallet permission. Its first step says quoted entry and exit costs; in this case the charged amount is entry only because there are no used source positions. The detailed risks explain that future destination exit is excluded. Preserve this wording qualification.

[Original human answer](manual/yield/founder-response-original.txt) | [Agent output](agent/yield/deliverable.json) | [Frozen request](agent/yield/inputs/request.json) | [Public receipt](https://positioncrew.dolepee.com/api/benchmark-receipts/3813d871-5612-49b1-a45f-979ce5748297)

## What this supports

Three genuine founder responses now accompany three fixed real-source public-marketplace assessments. Core decisions agree: no rescue, keep LP range, conditional USDT yield allocation. Independent arithmetic supports the reported rounded values. The yield agent explicitly budgets the entry cost; agent outputs also preserve more detailed structured model disclosure. The Lending wording caveat and other limitations remain visible.

This replaces the absence of manual responses for this particular study. It does not rewrite or erase the older synthetic benchmark. It does not establish independent customers, paid commerce, realised trading performance, controlled speedup, three agent victories, or automatic sponsor acceptance of the real-task/high-stakes requirement. Yield remains real-market scenario analysis, not a funded real portfolio.

## Publication boundaries

Original requests, both outputs, worksheets and corrections accompany this report. Protocol fields and private historical path strings remain as originally recorded; private paths are provenance, not public download links. The relative links in this report identify the attached public artifacts. Old synthetic comparisons remain separate and unchanged.

The scoring dimensions were prewritten; the application of them in this report is retrospective AI-assisted judgment. Original answers must not be silently replaced by these explanatory calculations.

[Arithmetic calculations](paired-arithmetic.json) | [Time corrections](manual/participant-time-corrections.md) | [Protocol](protocol.json)


## Supplied manual instructions

[Lending worksheet](worksheets/lending.md) | [LP worksheet](worksheets/lp.md) | [Yield worksheet](worksheets/yield.md)

These instructional materials were AI-prepared after agent capture. They are attached to make the human assistance and shared model assumptions inspectable, not to claim the worksheets were precommitted before agent outputs.
