# Bounded TermiX analysis services

The dedicated Lending, LP, Yield and Grid agents can accept and deliver newly funded 5 USDC (or
explicitly configured 5 USDT) analysis orders without a founder operating each
order. The coordinator uses the existing artifact-verifying delivery worker.
It does not execute recommendations, release buyer escrow, or take disputes.
All four use one coordinator, wallet lock and aggregate reservation ledger.
`enabledServices` explicitly selects the supported services; omitting it keeps
existing policies Lending-only. Agent/listing pairs are pinned in code.

Policy is a protected file, not a chat command. It pins chain 56, the dedicated
agent/listing, price, currency and the current escrow from authenticated config.
It also sets a start time, expiry (at most 14 days), transaction gas cap
(at most 0.000034 BNB), total reservation cap (at most 0.00204 BNB), rolling
reservation cap (at most 0.000408 BNB), and order cap (at most 20).
Each order reserves three transaction slots before signing: acceptance plus two
delivery rounds. All open reservations count against the rolling cap; closed
ones remain counted for 24 hours. Total reservations never reset automatically.
An existing ledger refuses a different policy hash. Renewal requires deliberate
budget reconciliation, rather than discarding its ledger.

Lending requirements can be the existing structured JSON, the previous explicit full
sentence, or the labelled fields in `LENDING_REQUIREMENTS_GUIDE`. Missing or
ambiguous inputs cause an idempotent clarification in the actual order chat.
The latest buyer-origin reply is authenticated and sealed into the per-order
policy. Constraints remain fixed after admission. Arbitrary instructions cannot
select contracts, credentials, transactions or spending limits. The account is
queried successfully before admission. Results are regenerated from current
observations when delivery begins. Lending retains five-minute freshness. LP,
Yield and Grid retain two-minute freshness and require 90 seconds remaining
before signing, with a 30-second recovery margin and ten-second receipt wait.
The shared timer runs every ten seconds; it never overlaps another worker.

Acceptance requires current `PENDING_ACCEPT` state, a prepared intent with the
exact escrow/order/calldata, zero provider lock in live config, and successful
contract simulation. The current API does not return `canProviderAccept` or an
accept deadline. An explicit false flag or expired deadline still rejects; when
absent, the coordinator checks the delivery deadline and the contract enforces
its acceptance window during simulation and execution. No synthetic flag is
inserted into the platform DTO. Backend-provided artifact manifest hashes retain
the documented trust boundary; downloaded artifact bytes are independently
verified before delivery.

## Installation and verification

1. Run typechecks, service policy/runtime tests and `npm run build:termix-orders`.
   Release only through the repository's exact-head Codex review/CI gate.
2. Install `run-termix-service.mjs`, `fulfill-termix-lending.mjs` and
   `prepare-termix-lending-delivery.mjs` together in
   `/opt/positioncrew-termix-orders`. Install the updated observer as well.
3. Install a root-protected `/etc/positioncrew-runtime/service-policy.json` and
   the matching service/timer units. Keep the old exact-order timer disabled.
   Both workers use `/var/lib/positioncrew-fulfill/worker.lock` via `flock`.
4. On the current LXC VPS, its global `zzz-lxc-service.conf` resets credentials.
   Use a per-unit `zzzz-load-credential.conf` to restate all seven LoadCredential
   directives, NoNewPrivileges and TasksMax=64. Check the effective unit.
5. First run without `--execute`, using the same protected credentials and
   service-state directory. This scans and validates but signs, replies and
   reserves nothing. Then enable the timer for the approved policy.
6. Verify timer state, a completed live scan, and retained existing chat/token
   renewal services. A scan with no new orders is not a paid end-to-end test.
   A new funded order is needed to prove automatic acceptance and delivery live.

Before any new signature, all persisted journals are reconciled and the latest
and pending wallet nonces must agree. Unknown RPC errors never mean a missing
receipt. Signatures are fsynced before broadcasting and never silently replaced.
An unresolved expired signature or a mined revert requires reconciliation.
Per-order validation failures are reported without starving other valid jobs;
a failure after possible signing stops the batch until the next recovery pass.
Worker stderr is retained only in the protected per-order failure record.
Systemd OnFailure sends the existing operational alert. No notification contains
keys, tokens or signed raw transaction bytes.

## LP, Yield and Grid intake

These services require a JSON object in the checkout's buyer requirements field
(or an authenticated order-chat reply). The platform adds `Buyer requirements:`
to the stored scope. Use `schemaVersion: "positioncrew.termix-capital-request.v1"`,
`analysisOnly: true`, `service`, `maxActionUsd`, `maxGasUsd`, `maxSlippageBps`
and the service-specific fields below. USD amounts are decimal strings; bps,
tick widths, counts and horizons are numbers. `orderId` may be omitted during
checkout; the worker binds it to the authenticated order. If supplied, it must
match. Unknown fields and executable requests are rejected.

- `LP_REBALANCE`: `positionTokenId` and constraints `minimumWidthTicks`,
  `maximumWidthTicks`, `edgeBufferBps`, `highVolatilityBps`,
  `maximumToken0ShareBps`, `maximumToken1ShareBps`, `minimumNetBenefitUsd`,
  `evaluationHorizonHours`. The public Pancake position must be observable;
  slippage cannot exceed the live cost model's 30 bps.
- `YIELD_OPTIMIZATION`: `account`, `capitalUsd`, `capitalSource: "HYPOTHETICAL"`,
  `maxExecutionCostUsd` and constraints `protocolAllowlist`, `maximumRiskTier`,
  `maximumProtocolConcentrationBps`, `maximumLockupSeconds`,
  `minimumLiquidityUsd`, `minimumNetBenefitUsd`, `evaluationHorizonDays`.
  Live observations currently cover Venus Core Pool stablecoin markets.
- `BOUNDED_GRID`: `account`, `capitalUsd`, `capitalSource: "HYPOTHETICAL"` and
  constraints `lowerPrice`, `upperPrice`, `levelCount: 5`, `maximumInventoryUsd`,
  `maximumLossUsd`, `minimumExpectedNetProfitUsd`, `minimumLiquidityUsd`,
  `maximumVolatilityBps`, `expectedCompletedCycles`, `orderExpirySeconds`
  (60–120). Live observations cover Pancake WBNB/USDT. Five levels match the
  supported gas estimate.

Yield and Grid capital must be between 1 and 10000000 USD, with at most two
decimal places. It is scenario capital, not a verified balance or permission to
spend. LP reads a public position, not wallet signing authority. Reports can
recommend no action when limits or market conditions do not support a trade.
Prices, venue addresses, tick spacing and cost estimates come from BSC probes,
not buyer-supplied fields. The artifact binds the service, buyer requirements,
order, delivery round, observation and conformance result.

## Enabling additional services on an existing installation

Keep the policy's existing dates, caps and complete reservation history. Stop
the timer and acquire the shared worker lock. Back up the policy, ledger,
bundles and effective systemd units. Verify the ledger's existing policy hash,
then add the chosen `enabledServices` and update only the ledger's policy hash
to the canonical hash of the validated new policy. Do not erase reservations
or signed journals, reset budgets, or change existing per-order policies.

Install the three additional protected runtime credentials and their
`TERMIX_LP_RUNTIME_TOKEN_FILE`, `TERMIX_YIELD_RUNTIME_TOKEN_FILE` and
`TERMIX_GRID_RUNTIME_TOKEN_FILE` environment paths. All agents still use the
same dedicated seller wallet; the owner key is not duplicated into application
source. Run the updated coordinator without `--execute` before restarting the
timer. Simulated delivery tests and an empty live scan do not prove a new
service's paid path: each needs its own funded order and verified report.
