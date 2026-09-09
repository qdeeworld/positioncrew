# Buyer-approved Venus execution

A completed current first-party Yield `SUPPLY` recommendation can prepare an exact USDT deposit. Preparation binds the source receipt, request commitment, buyer wallet, BSC chain56, token, market, amount, transaction nonces and review expiry. The server verifies the signed observation and result commitment, independently rechecks economics and current protocol conditions, and persists one immutable supply plan per source receipt. Every signature belongs to the buyer's wallet.

Supported market: Venus Core vUSDT `0xfD5840Cd36d94D7229439859C0112a4185BC0255`, underlying USDT `0x55d398326f99059fF775485246999027B3197955`. The current allowlist requires implementation `0xCDfea50f7CECCB24Fe804657DB8E6c93b689941e`, 18 underlying decimals and 8 share decimals. An implementation or identity change stops execution pending review. The first path requires no enrolled Venus collateral or borrowing exposure. It creates no swap, borrow, collateral enrollment, migration or delegated permission.

## HTTP lifecycle

All requests use the public product origin. JSON mutations use `Content-Type: application/json`; foreign browser origins are rejected. The API returns unsigned transactions and never broadcasts. `{receiptId}` is the completed assessment's UUID.

| Method and path | Input | Result |
| --- | --- | --- |
| `GET /api/markets/venus/stable-yields?account={wallet}&heldAsset=USDT` | Buyer wallet | Server-bound current USDT assessment input; visible allocation defaults may be tightened before hiring |
| `POST /api/buyer-venus/{receiptId}/prepare` | `{ "account": "0x…" }` | Saved exact supply plan, full round-trip cost model and projected benefit |
| `GET /api/buyer-venus/{receiptId}` | None | Saved plan, pending/confirmed transaction hashes, position and withdrawal evidence |
| `POST /api/buyer-venus/{receiptId}/preflight` | `{ "step": 0 }` | Fresh verification of the original step; repeat for each approval/supply step |
| `POST /api/buyer-venus/{receiptId}/confirm` | `{ "step": 0, "transactionHash": "0x…" }` | Pending status or confirmation after 15 BSC blocks; exact sender, calldata, nonce and receipt checks |
| `POST /api/buyer-venus/{receiptId}/withdraw-quote` | `{}` | Fresh quote for only the shares minted by this deposit |
| `POST /api/buyer-venus/{receiptId}/withdraw-preflight` | `{}` | Rechecked quote, wallet nonce, shares, cash, fee and gas |
| `POST /api/buyer-venus/{receiptId}/withdraw-confirm` | `{ "transactionHash": "0x…" }` | Verified redemption and underlying delivery |

The wallet signs and sends each returned transaction after explicit buyer review. A zero/nonzero Venus return code is checked in simulation; EVM success alone does not establish supply or redemption. Positive protocol events and token transfers must agree with the saved amount and buyer. Share value uses `rawShares * exchangeRateMantissa / 1e18`, with deployment decimals verified separately. Confirmation state is persisted with compare-and-swap updates to prevent lost progress.

## Limits

- Review expiry is a pre-sign freshness check. Direct Venus calls have no onchain deadline or minimum-receipt argument; an already signed transaction can be mined after the review window.
- Future APY, prices, gas, fees and redemption liquidity are estimates or variable conditions. The current fee and estimated exit gas are included before supply; withdrawal is re-quoted when requested.
- The exact allocation is never silently reduced to rescue failing economics. A changed amount or changed reviewed transaction requires another review or assessment.
- A reverted or otherwise unverified transaction does not trigger an automatic replacement. Retain the wallet transaction hash and inspect the saved status. After 15 confirmations, a reverted withdrawal is retained with its gas cost and a new quote becomes available for separate review and consent.
- Historical/founder tests, artificial fork balances and the separate operator-funded testnet sandbox are not buyer adoption, revenue or mainnet execution evidence.
- Other categories retain their assessment workflows. This path supplies first-party USDT recommendations only.

Apply `migrations/0007_buyer_venus_executions.sql`, or the equivalent Sites migration `drizzle/0006_buyer_venus_executions.sql`, before deploying. `BUYER_VENUS_RPC_URL` is optional trusted server configuration for a dedicated RPC or isolated fork; HTTP callers cannot choose it. Production defaults to the official BSC endpoints.

Protocol references: [Venus Core vToken](https://docs-v4.venus.io/technical-reference/reference-core-pool/vtoken), [protocol mathematics](https://docs-v4.venus.io/guides/protocol-math), [deployed markets](https://docs-v4.venus.io/deployed-contracts/markets).
