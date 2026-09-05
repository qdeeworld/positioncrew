# Server-bound current observations

Current BSC probe responses include a top-level `observationBinding` signed by
the Worker. A current hire must return that binding unchanged alongside the
original three-field `observation` and its request. Lending's audition-hire alias
has the same requirement. Server-collected Grid hires use the same signer.

## Configuration and rollout

Configure a dedicated Worker secret named `SOURCE_OBSERVATION_HMAC_KEY` before
enabling this release. Use independently generated high-entropy secret material,
not a wallet key, scheduler credential, or public token. The implementation
accepts a nonblank UTF-8 string of at least 32 bytes and at most 512 characters.
A 64-character hexadecimal secret is accepted as the literal UTF-8 key string;
it is not hex-decoded. There is no production fallback.

Do not place the secret in source control, public environment configuration,
logs, receipts, or browser code. The explicit keys in tests are only for isolated
synthetic test observations and must never be configured in production.

Missing configuration or an absent, invalid, changed, or expired binding fails
closed with `REFRESH_REQUIRED`. Refresh the market or position rather than
extending a signed deadline. Rotating the key invalidates outstanding bindings;
clients must refresh. Completed historical hires and receipts remain readable
without the key and are not re-signed or regenerated.

## Signed facts

The HMAC authenticates the version, original request ID, service, BSC chain ID,
account, exact block number and source timestamp/URL, immutable request hash,
issue time, absolute expiry, original deadline, maximum source age, and original
slippage ceiling. Canonical JSON and HMAC-SHA-256 are used. The full parsed request
is immutable by default, with only the explicit policy fields below excluded.
New request fields are therefore bound unless deliberately classified otherwise.

Holdings, debt, available assets, asset identities, prices, source metadata,
pool/market addresses, liquidity, opportunity capacities, APYs, thresholds,
observed risk, fee data, gas quotes, swap quotes, and LP tick spacing are not
editable by a caller.

## Editable buyer policy

- Common: action and gas budgets, slippage limit, deadline, maximum source age.
- Lending: allowed actions, target health factor, stress drop, oracle deviation tolerance.
- LP: width limits, edge buffer, volatility threshold, token-share caps, minimum benefit, evaluation horizon.
- Yield: intended capital, protocol allowlist, accepted risk, concentration/lockup limits, minimum liquidity/benefit, evaluation horizon.
- Grid: capital, range, level count, inventory/loss caps, minimum profit/liquidity, volatility cap, expected cycles, order expiry.

The deadline and maximum source age can only be tightened; they cannot extend
the signed expiry. LP slippage can only be lowered because the frozen swap-cost
quote includes the original slippage allowance. Changing Yield capital does not
increase any authenticated per-opportunity capacity. Budgets are buyer policy,
not proof of wallet wealth.

## Enforcement and limits

Creation verifies before storage admission and provider auditions. Job execution
verifies before selecting or claiming a current hire, then verifies again before
provider execution. This includes previously created unbound current hires.
Completed LP jobs still enforce their original immutable provider choice.

The binding proves what this server observed, not account ownership, settlement,
future prices, economic correctness, or fresh state beyond its bounded lifetime.
It does not claim protection against a compromised signer or upstream RPC.
Signed observations may be reused within their lifetime under the existing hire
admission and idempotency rules; this is not a one-use authorization or a payment.

Binding metadata lives beside the source in current evidence. It is not injected
into original request/source structures or historical request/receipt hashes.
New current evidence commits the binding through its ordinary evidence hash.

## Validation

Unit tests cover all four immutable projections, allowed policy changes,
tampering, cross-context replay, key failures, exact expiry, API aliases, probe
issuance, execution-time expiry, legacy reads, and the inactive LP response.
The real-D1 integration scripts use an explicit isolated test key and signed
synthetic observations, while retaining the actual Worker and D1 lifecycle.
Run those scripts on Linux CI; they do not require production secrets or money.
