# PositionCrew

PositionCrew is a job-first BSC marketplace for bounded capital operations. A buyer chooses a task, sets hard limits, hires a provider, and receives either an immediately usable machine-readable action or an explicit refusal with the failed conditions.

Public application: [positioncrew.dolepee.com](https://positioncrew.dolepee.com)

[![Quality](https://github.com/qdeeworld/positioncrew/actions/workflows/quality.yml/badge.svg)](https://github.com/qdeeworld/positioncrew/actions/workflows/quality.yml)
[![Production smoke](https://github.com/qdeeworld/positioncrew/actions/workflows/production-smoke.yml/badge.svg)](https://github.com/qdeeworld/positioncrew/actions/workflows/production-smoke.yml)

The product covers all four Build the Era categories with equal depth:

- **Lending rescue:** compute the smallest feasible repay or collateral top-up for a target health factor.
- **LP rebalancing:** move a concentrated-liquidity range only when fee, gas, slippage, inventory, and break-even checks pass.
- **Yield optimisation:** recommend an allocation only when liquidity, uplift, concentration, and risk constraints are satisfied.
- **Bounded grid construction:** construct orders only inside explicit inventory, fee, volatility, and worst-case-loss limits.

## Product surfaces

The web application is the primary interface:

- **Marketplace:** searchable provider registry with distinct provider endpoints, ERC-8004 identity, health routes, listed testnet price, a no-wallet provider trial, schema version, category coverage, and conformance status. The system panel reads the latest BSC block, PancakeSwap V3 WBNB/USDT pool, Venus vUSDT market, and verified Provider identity count.
- **Jobs:** provider selection, editable buyer constraints, block-pinned Venus account, Venus stablecoin yield, PancakeSwap market, and PancakeSwap position request builders, create/fund/assign/submit/evaluate/complete conformance lifecycle, human result, machine JSON, downloadable receipts, and persistent local history. For a Venus Classic account with collateral and debt, the builder reconstructs balances, effective risk factors, oracle prices, and wallet inventory at one BSC block, reconciles the result to the Comptroller, and lets the buyer send that unsigned request to the lending provider. The yield builder compares the listed Venus Core Pool USDC, USDT, DAI, and FDUSD markets at one block using measured base supply rates, available cash, oracle prices, token metadata, gas, and measured block time; incentive rewards are deliberately excluded. The LP builder reconciles a USDT/WBNB V3 NFT with its official position manager and pool, reconstructs its token inventory and value, simulates collectible fees without moving funds, and measures volatility and an exact onchain swap window at one block. The bounded-grid builder verifies WBNB/USDT token ordering and reads spot price, current active virtual liquidity, reserve balances, adaptive onchain volatility observations, and gas at one BSC block before enabling an interactive grid request. Protocol observations are locked in the UI while buyer constraints remain editable. Other interactive providers retain a clearly labeled current-clock scenario; a separate locked mode reproduces the historical public fixture receipt and labels it non-executable.
- **Evidence:** live infrastructure register, TermiX production AACP readiness, six precommitted no-retry marketplace deliveries, a fixed-epoch non-cherry-picked production verification record, funded ERC-8183 testnet receipts, public content-addressed deliverables for all four categories, frozen benchmark hashes, Agent Advantage progress, and explicit claim boundaries.

The flagship cold-buyer journey is **Rescue a lending position**. It returns exact token base units, projected health factor, execution preconditions, expiry, deterministic evaluation, and a fail-closed refusal when evidence is stale or constraints make the action unsafe.

## Durable no-wallet hires

The public hire API provides a D1-persisted outer lifecycle for all four current block-referenced BSC request categories: `lending-rescue`, `lp-rebalance`, `yield-optimization`, and `bounded-grid`. It commits the request, provider binding, declared block evidence, result, evaluation, and timing trace so a completed receipt can be reloaded after the creating browser session ends. The observation is caller-supplied and is not independently re-fetched during provider execution, so every result must be revalidated before financial action.

The current bounded-grid journey also auditions Brain on BNB ERC-8004 agent `#302258` against the same frozen PancakeSwap job. PositionCrew preserves the provider's raw replay claim, verifies its pool, pair, fee tier, capital, block window, activity, economics, range, expiry, and output contract, and exposes every acceptance or refusal in the durable receipt. A two-provider Live Match is claimed only when both providers remain actionable under that exact job; no payment, authority grant, order placement, swap, or protocol transaction occurs.

Three separate historical tasks remain immutable: `lending-rescue`, `lp-rebalance`, and `bounded-grid`. They reproduce the committed frozen fixtures and do not widen historical evidence to yield optimisation.

The persisted lifecycle uses these routes:

- `POST /api/benchmark-hires` creates the hire and its `CREATED` job before provider computation;
- `POST /api/benchmark-hires/{hireId}/jobs` claims and starts that persisted job;
- `GET /api/benchmark-hires/{hireId}` polls the persisted hire, job, and optional receipt chain;
- `GET /api/benchmark-receipts/{receiptId}` reloads the completed receipt and its exact response commitments.

D1 persistence is an evidence and lifecycle boundary, not an execution claim. The provider computation still uses the in-memory conformance adapter: it costs `$0.00`, requires no wallet, creates no payment or settlement, signs nothing, and broadcasts no protocol transaction.

## BSC provider identity

Each first-party provider has a separate ERC-8004 identity on BSC Testnet. The identity URI binds the public provider manifest and health endpoint; the scheduled production monitor resolves `ownerOf` and `tokenURI` from the registry before it accepts a provider as operational.

| Provider | ERC-8004 agent | Registration |
| --- | ---: | --- |
| Lending Rescue | `1810` | [transaction](https://testnet.bscscan.com/tx/0x828b810e1dc5f3e30859afbeb5a74deb728ed60c5d7cce09e9b44ed4be07aaaf) |
| LP Range Operator | `1811` | [transaction](https://testnet.bscscan.com/tx/0x7e94ae42091364cd110db183bb32055db3238008e8804dffc426dae76e393168) |
| Yield Allocator | `1812` | [transaction](https://testnet.bscscan.com/tx/0xfeb0d02eaa3a57c237d22a4d574497493e28e96b19dbbb363a127d23206a29da) |
| Bounded Grid Builder | `1813` | [transaction](https://testnet.bscscan.com/tx/0x8466e273149a1178e15db544964de83767450450ec334abb61e9cd24df95bbb4) |

The registry is [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.bscscan.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e). Public receipts and metadata are recorded in [`evidence/bsc-identities.testnet.json`](evidence/bsc-identities.testnet.json). [`scripts/register-bsc-identities.py`](scripts/register-bsc-identities.py) reproduces the official BNB Agent SDK registration path with the pinned [`bnbagent` dependency](scripts/requirements-bsc-identity.txt), while keeping the encrypted signing wallet outside Git.

## Upstream BNB SDK contribution

PositionCrew's integration work exposed a stale APEX policy preset in the official BNB Agent SDK: the configured BSC Testnet policy was no longer whitelisted, so `registerJob()` reverted with `PolicyNotWhitelisted`. [BNB Chain merged our correction as `bnb-chain/bnbagent-sdk#73`](https://github.com/bnb-chain/bnbagent-sdk/pull/73) on August 17, 2026.

The contribution updated the whitelisted policy and rotated implementation snapshots, kept Python, TypeScript, and deployment documentation in sync, and added exact registry regression coverage. Its upstream verification record reports 776 passing Python tests and 1,107 passing TypeScript tests. This is evidence that PositionCrew improved a sponsor-maintained integration path; it is not represented as product adoption, revenue, or endorsement.

## TermiX production readiness

`GET /api/commerce/aacp` validates the current official TermiX production config, independently probes every unique BNB Chain contract for bytecode, and discovers the four exact PositionCrew provider handles and listings through the public Agent.family API. The adapter requires chain ID `56`, both documented settlement currencies, one default currency, explicit provider-lock data, the shared ERC-8004 identity registry, and non-zero configured contracts. It fails closed to `SOURCE_UNAVAILABLE` or `PROTOCOL_DEGRADED` instead of substituting cached deployment claims.

Each prepared Agent.family listing includes a category-specific 1200×675 cover captured from the corresponding public locked-result view. Run `npm run capture:listing-media` to reproduce the four images; every cover visibly preserves the historical-fixture and revalidation boundary instead of implying current execution.

This is an onboarding and liveness record, not payment evidence. PositionCrew verifies four owner-controlled Agent NFTs, four published TermiX listings, and their current runtime presence independently. It does not claim stake, a paid AACP order, settlement, revenue, reputation result, or an external buyer until those events exist and can be verified independently.

The repository also includes a deterministic TermiX A2A host (`npm run runtime:termix`). It accepts only an agent-scoped runtime token, refuses to start when wallet signing material is present, stops before the token expires, deduplicates overlapping inbox polls, answers service inquiries from fixed provider contracts, and escalates delivery, challenge, and operator-case threads instead of auto-acting. One additional dedicated Lending Rescue identity uses a separate root-only signer service to rotate only its scoped runtime token; the unprivileged poller never receives the owner key. Three completed automatic rotations are recorded in [`evidence/termix-runtime-rotations.mainnet.json`](evidence/termix-runtime-rotations.mainnet.json). They are discrete host-observed renewal events, not evidence of continuous uptime, availability between observations, or future renewal success. The original four-provider readiness counts and the additional dedicated flagship remain separate.

The signer-free AACP order guard models checkout through settlement or refund without calling TermiX or broadcasting. Before an operator signs, it decodes each documented escrow call and binds the exact token, amount, agent identities, agreement, acceptance deadline, delivery deadline, challenge window, order, delivery hash, and dispute panel. After broadcast, it requires the mined transaction target, calldata, value, actor, and chain to match the reviewed intent, then waits for a monotonic indexer projection instead of treating a receipt as marketplace state. PositionCrew's deterministic conformance scorer is application-level evidence; it is not represented as AACP's operator-granted dispute Evaluator role.

Run one provider only after its owner has issued a scoped runtime token through the official TermiX flow:

```bash
export TERMIX_A2A_AGENT_ID=<owned-agent-database-id>
export TERMIX_A2A_RUNTIME_TOKEN=<scoped-runtime-token>
export POSITIONCREW_SERVICE=LENDING_RESCUE
npm run runtime:termix
```

Opaque tokens must also set `TERMIX_A2A_RUNTIME_TOKEN_EXPIRES_AT` to an ISO-8601 timestamp. Runtime state is written atomically under `.state/`, excluded from Git, and contains message IDs and operator-attention metadata but no token or message text.

The production systemd templates are tracked at `deploy/systemd/positioncrew-runtime@.service` and `deploy/systemd/positioncrew-runtime-renew@.service`. Credential expiry exits with status `78`, which systemd treats as terminal rather than restart-looping. The dedicated renewal unit signs only the fixed agent-scoped challenge, atomically replaces the scoped token and its expiry override, and restarts only that runtime instance. The scheduled production monitor treats the four public PositionCrew provider endpoints, identities, listings, schemas, current BSC inputs, and retained commerce receipts as the core health surface. It reports the original four-provider A2A presence and the additional dedicated flagship separately; the three recorded rotations establish that the dedicated renewal path completed three times, not durable uptime.

The normal production build creates `dist/runtime/renew-termix-runtime-token.mjs`. Install that reviewed artifact as root before enabling a renewal timer:

```bash
sudo install -d -o root -g root -m 0755 /opt/positioncrew-runtime-renew
sudo install -o root -g root -m 0500 dist/runtime/renew-termix-runtime-token.mjs /opt/positioncrew-runtime-renew/renew-termix-runtime-token.mjs
```

The renewal unit refuses to start when either the root-owned artifact or the instance owner-key credential is absent.

## BSC commerce receipts

PositionCrew has completed seven ERC-8183/APEX lifecycles on BSC Testnet: one zero-price path probe and six funded jobs releasing `0.6 U` from a dedicated client wallet to a separate provider wallet. The four flagship jobs cover every required category and bind each public deliverable manifest to the onchain job.

| Service | Job | Provider identity | Escrow | Settlement |
| --- | ---: | ---: | ---: | --- |
| Lending Rescue | `490` | `1810` | `0.1 U` | [transaction](https://testnet.bscscan.com/tx/0x731cb1f760ffb0c870458dc3db68d22d97d8b9c10f1bc192f9e3cc1ee018a76f) |
| LP Range Operator | `491` | `1811` | `0.1 U` | [transaction](https://testnet.bscscan.com/tx/0x267b9b8293947e2f462857d87283f1db2ee8d2e60adc0dd0d4406a11b54dd78a) |
| Yield Allocator | `492` | `1812` | `0.1 U` | [transaction](https://testnet.bscscan.com/tx/0x0fac752328aa325382ea28f92f939b8c0f76750631f5460ed0706100f0b51d58) |
| Bounded Grid Builder | `493` | `1813` | `0.1 U` | [transaction](https://testnet.bscscan.com/tx/0xb9215bfa352d2626b49e5455fbb63a81cc018a1dcfb734eac6b75e192caba1e9) |

The machine-readable [`evidence/erc8183-jobs.testnet.json`](evidence/erc8183-jobs.testnet.json) ledger records every transaction, policy parameter, manifest hash, completion block, and claim boundary. These are disclosed same-operator integration tests using separate wallets. They are not external purchases, revenue, or the pending blind Agent Advantage result.

## Run locally

Requires Node.js 22 LTS.

```bash
npm install
npm run dev
```

The local Cloudflare-compatible worker serves the application on `http://127.0.0.1:4175`. The same worker routes used in production expose:

- `GET /api/providers` for the provider catalog;
- `GET /.well-known/positioncrew.json` for the marketplace discovery manifest;
- `GET /openapi.json` for the four-provider OpenAPI 3.1 contract;
- `GET /api/evidence/venus-testnet-native-supply/2026-08-24` for one immutable, founder-controlled Venus BSC Testnet supply receipt using exactly `0.0001 tBNB`;
- `GET /api/providers/:provider/manifest` for a self-contained provider transport and claim boundary;
- `GET /api/schemas/:schemaVersion` for exact request or deliverable JSON Schema;
- `GET /api/status` for block-pinned BSC, PancakeSwap, Venus, and integration-boundary telemetry;
- `GET /api/operations/production` for every observed scheduled production verification run after the fixed monitoring epoch, including unsuccessful outcomes, recomputed from the durable public snapshot on the dedicated `production-monitor` branch;
- `GET /api/benchmarks/repeatability` for the three locked TermiX tasks and six reproducible provider repeats;
- `GET /api/benchmarks/captures` for the source-bound, hash-only manifest of the six precommitted agent candidates;
- `GET /api/benchmarks/marketplace-provenance` for the immutable six-call public delivery record and its precommitted protocol binding;
- `GET /api/benchmarks/:task/repeatability` for lending-rescue, lp-rebalance, or bounded-grid evidence;
- `GET /api/commerce/erc8183` for the complete seven-job BSC Testnet ledger;
- `GET /api/commerce/erc8183/jobs/:jobId/deliverable` for a canonical onchain-bound deliverable manifest;
- `GET /api/commerce/aacp` for fail-closed TermiX production contract, currency, provider, listing, and A2A readiness;
- `GET /api/matrix` for all frozen conformance runs;
- `GET /api/providers/:provider/health` for a provider-specific liveness and conformance probe;
- `POST /api/benchmark-hires` to persist one of four current block-referenced hires or one of three immutable historical hires before computation;
- `POST /api/benchmark-hires/{hireId}/jobs` to claim and run the already-persisted hire;
- `GET /api/benchmark-hires/{hireId}` to poll the durable hire, job, and optional receipt chain;
- `GET /api/benchmark-receipts/{receiptId}` to reload an exact completed receipt;
- `GET|POST /api/providers/:provider/jobs` for the provider-specific job route (`POST` defaults to caller-supplied observations; `mode: FROZEN_FIXTURE` is required for the locked receipt);
- `GET /api/receipts/:evaluationHash` for a public reproducible fixture receipt;
- `GET /api/wallets/:address/venus` for a block-pinned Venus Classic position reconstruction and, when both collateral and debt exist, an embedded bounded rescue request;
- `GET /api/positions/pancake/:tokenId` for a block-pinned PancakeSwap V3 USDT/WBNB position reconstruction and embedded unsigned LP-rebalance request;
- `GET /api/markets/pancake/wbnb-usdt/grid` for a block-pinned PancakeSwap market reconstruction and embedded unsigned bounded-grid request;
- `GET /api/markets/venus/stable-yields` for four block-pinned Venus stablecoin base-rate markets and an embedded unsigned yield-allocation request;
- `GET /api/jobs?service=LENDING_RESCUE` for a frozen job;
- `POST /api/jobs` for a caller-supplied request;
- `GET /api/rescue` for the flagship lending fixture.

## Reproduce the evidence

```bash
npm run benchmark:verify-lock
npm run benchmark:verify-captures
npm run benchmark:session -- prepare lending-rescue
npm run benchmark:verify-report -- <completed-report-directory>
npm run verify:gate2a
npm run verify:all
npm run typecheck
npm test
npm run test:e2e
npm run verify:production
```

The lending result is written to `artifacts/gate2a/lending-rescue-result.json`; the four-category matrix is written to `artifacts/main-track/provider-matrix.json`.

Deterministic `100/100` results establish provider conformance against frozen fixtures. They do **not** establish agent advantage over a human baseline. Lending rescue, LP rebalancing, and bounded-grid task packets, rubrics, timing rules, and blinding protocols are pre-registered under [`benchmarks`](benchmarks); independent comparisons remain pending and the UI says so.

The executable [Agent Advantage evidence workflow](benchmarks/EVIDENCE_WORKFLOW.md) captures immutable agent and manual candidates, withholds answer-bearing rubric text from the manual operator, keeps duplicate agent repeats out of the blind packet, enforces one manual operator and a different blind evaluator across all three tasks, recomputes every completed result from source evidence, and reveals the committed source mapping only after scoring. The final verifier binds every JSON attachment into task and report commitments and regenerates the standalone judge-facing HTML and Markdown presentations to reject edits. The report also carries the six no-retry public marketplace deliveries and a hash-bound copy of the seven-job BSC Testnet commerce ledger. It presents that four-category operating record beside its disclosed same-operator relationship, zero external buyers, and zero external revenue instead of asking judges to infer track record from a separate proof page.

The separately committed [marketplace invocation protocol](benchmarks/marketplace-invocation-protocol.v1.json) measures two sequential end-to-end POST deliveries for each flagship benchmark through the public Provider endpoints. It binds the original candidate hashes, preserves every planned call without retry or replacement, and keeps public HTTP delivery latency separate from the pre-registered internal agent timer. The overlay proves marketplace delivery only; it remains a free, no-wallet, in-memory conformance trial rather than paid AACP settlement or live performance.

The public Evidence page is driven by a committed pending-status record. It can switch to a completed report only through `benchmark:publish-report`, which re-verifies the full bundle, requires an explicit independent-human acknowledgement, and stages only allowlisted evidence files.

Offline role-specific handoff tools reduce procedural errors without weakening the blind: the manual tool auto-times and hashes one answer-free task bundle, while the evaluator tool exposes only anonymized candidates and the frozen rubric. Both are generated from the committed session and make no network requests.

## Architecture

- Frozen Zod schemas define requests and deliverables for each category.
- Provider implementations use fixed-point arithmetic and deterministic refusal paths.
- Canonical hashes bind request envelopes, deliverables, and evaluations.
- A replaceable `CommerceAdapter` owns exact funding and idempotent state transitions.
- The TermiX production adapter reads the supported AACP config and public Agent.family discovery APIs, then independently confirms contract bytecode on BNB Chain. Wallet-signed onboarding and value-bearing orders remain explicit operator actions.
- The TermiX A2A host is a pre-signing runtime: a scoped token can keep one provider present and answer pre-sale questions, while private keys, order acceptance, delivery submission, settlement, and disputes remain outside the process.
- The TermiX order guard ABI-decodes ten documented AACP order actions, including both refund paths, binds reviewed intent to mined transaction evidence, and reconciles `ACCEPTED`, `CANCELLED`, and terminal indexed state without holding a signer or broadcasting transactions.
- A Cloudflare-compatible worker exposes the same typed core used by the CLI and tests, plus direct BSC JSON-RPC reads through `viem`.
- ERC-8004 identities bind each live provider endpoint on BSC Testnet; production checks fail if ownership, registration, or endpoint binding changes.
- ERC-8183/APEX jobs bind funded escrow, a provider, a canonical deliverable hash, an approved policy, and terminal settlement; the production monitor re-verifies all seven jobs directly from BSC Testnet. It also posts one current-clock scenario and one locked-receipt request to every Provider, rejecting expired scenario output, public evidence leakage, or any locked evaluation-hash drift.
- The public operating record aggregates the latest 100 scheduled monitor runs after the committed epoch, excludes push and manual events, and keeps failures in the denominator. Each scheduled workflow writes its outcome to a durable snapshot on the dedicated `production-monitor` branch before enforcing the check result. The application validates the fixed epoch and recomputes every count and rate from the recorded runs instead of trusting snapshot summary claims. Snapshot unavailability produces an explicit unavailable state rather than an inferred pass rate.
- React provides the buyer marketplace and job workspace without duplicating decision logic in the browser.

## Claim boundary

The optional Venus native-supply receipt proves one bounded `0.0001 tBNB` action by the disclosed operator on BSC Testnet. Its preflight observed zero native BNB balance and pending nonce on BSC mainnet at one timestamp but did not inventory tokens or NFTs. It proves no external buyer, revenue, autonomous custody, strategy return, repeated track record, marketplace demand, or financial performance, and it is not a performance claim.

The four-category current public-hire outer lifecycle persists the request, provider and block-evidence commitments, job state, result, evaluation, and receipt in D1. The provider computation within that lifecycle remains an in-memory conformance rail and does not submit a buyer's wallet transaction. Its no-wallet provider trial collects no token; the displayed `5 TEST_USDC` is a listed testnet price, not trial revenue. The durable hire path likewise costs `$0.00`, requires no wallet, creates no payment or settlement, signs nothing, and broadcasts no protocol transaction. The Venus and PancakeSwap builders read block-pinned public state, but their embedded requests and provider outputs remain unsigned and must be revalidated before execution. Venus APYs are variable base rates derived from per-block rates and measured block time; they exclude incentives and do not remove stablecoin depeg risk. Pancake active liquidity is a current virtual-liquidity estimate from `slot0` and the pool's active `liquidity`, not a fill guarantee across future ticks; the grid's cycle count is an explicit assumption. LP collectible fees come from a read-only `collect` simulation, and the displayed 24-hour volume and fee values are extrapolated run rates from an exact recent swap window rather than guaranteed future activity. Other interactive jobs validate caller-supplied scenario observations against the current request clock. Locked jobs reproduce the three immutable historical fixtures and public receipts but are not presented as current instructions; yield optimisation has no historical task. Separately, the public ERC-8183 ledger proves seven operator-controlled BSC Testnet lifecycles, including six funded completions; it does not prove external demand or revenue. The scheduled operating record measures production verification, not demand, financial performance, mainnet execution, or Agent Advantage. The production AACP endpoint verifies current protocol deployment and PositionCrew onboarding state; it does not prove a minted production Agent NFT, published listing, paid order, settlement, revenue, reputation, or external demand. No provisional ABI, undocumented write route, external-provider track record, or incomplete blind benchmark is represented as production evidence.
