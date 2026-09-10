# Bounded TermiX Lending service

The dedicated Lending agent can accept and deliver newly funded 5 USDC (or
explicitly configured 5 USDT) analysis orders without a founder operating each
order. The coordinator uses the existing artifact-verifying delivery worker.
It does not execute recommendations, release buyer escrow, or take disputes.
LP, Yield, and Grid continue to use their existing chat runtimes; this worker
must not be advertised as their automated paid fulfillment.

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

Requirements can be the existing structured JSON, the previous explicit full
sentence, or the labelled fields in `LENDING_REQUIREMENTS_GUIDE`. Missing or
ambiguous inputs cause an idempotent clarification in the actual order chat.
The latest buyer-origin reply is authenticated and sealed into the per-order
policy. Constraints remain fixed after admission. Arbitrary instructions cannot
select contracts, credentials, transactions or spending limits. The account is
queried successfully before admission. Results are regenerated from current
observations when delivery begins; their five-minute freshness is unchanged.

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
   Use a per-unit `zzzz-load-credential.conf` to restate all four LoadCredential
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
