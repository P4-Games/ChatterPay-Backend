# External Deposits Details

## Business Overview

The external deposits system detects when users transfer tokens or ETH from an external wallet into their ChatterPay smart wallet.

Two detection methods exist:

**Alchemy** — real-time webhook processing, used in production.
**The Graph** — scheduled blockchain indexing, used only for analytics or fallback.

For business context:
Alchemy provides instant recognition of deposits, showing updated balances and notifications in seconds.
The Graph runs on a delay, scanning historical blockchain data. It’s slower but useful for audits or as a safety backup.

## Technical Summary

### Provider Comparison

| Provider  | Trigger                  | Data Origin                 | Processing Path                                                                     | Use Case           |
| --------- | ------------------------ | --------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| Alchemy   | Webhook push (real-time) | Blockchain logs via Alchemy | `depositIngestorService` → `external_deposits` → `processAlchemyExternalDeposits()` | Production         |
| The Graph | API query                | Indexed subgraph            | `processThegraphExternalDeposits()`                                                 | Backup / Analytics |

All environment variables are defined in **`example_env`** at the root of the repository.

## Alchemy Flow (Webhook-based)

1. **Event Origin:** Alchemy sends webhooks whenever a monitored address receives ETH or ERC-20 tokens.

2. **Free Plan Limitation:**
   On Alchemy’s **free plan**, it is **not possible to programmatically register new wallets** through their Admin API.

   * Only manual wallet configuration is allowed.
   * When creating the webhook in the dashboard, you must manually enter all wallet addresses under “Addresses to monitor”.
   * Adding or removing wallets automatically requires a paid plan, where the Admin API endpoints are unlocked.

3. **Ingestion:**
   The `depositIngestorService.ingestDeposits()` reads and processes each Alchemy webhook payload as follows:

   * Extracts transfers from `logs`, `transaction`, or `activity` entries in the payload.
   * Normalizes sender, receiver, token, and amount fields into a consistent event format.
   * **Validates each event** before persisting:
     * Skips transactions that already exist in the `transactions` collection (`trx_hash`, case-insensitive).
     * Skips events where the sender (`from`) belongs to an internal ChatterPay wallet (`users.wallets.wallet_proxy`).
     * Logs all skipped items at `debug` level, including hash, from, to, and amount.
   * Persists only valid external deposits into the `external_deposits` collection with status `observed`.
   * Emits domain events for subsequent balance updates or notifications.

4. **Processing:**
   The `processAlchemyExternalDeposits()` job:

   * Validates that each token exists and is active for the chain.
   * Matches destination addresses against registered user wallets.
   * Skips duplicates already stored in `transactions`.
   * Inserts valid new deposits as `type: deposit`, `status: completed`.
   * Optionally sends formatted notifications to users.

5. **Wallet Sync (Paid Plan Only):**
   The `walletProvisioningService` keeps wallet lists synchronized through the `alchemyAdminService`, but this automation only works on paid plans. Free-tier setups must manage monitored wallets manually from the dashboard.

## The Graph Flow (Query-based)

1. The system periodically queries the configured GraphQL endpoint for recent transfers.
2. It excludes router and pool addresses to avoid internal protocol noise.
3. Each transfer is validated and matched against user wallets.
4. The transaction hash is derived from `transfer.id` (first 66 characters).
5. The normalized deposit is saved to `transactions`, and the last processed block is updated in `blockchain.externalDeposits`.

## Controller Integration

The `checkExternalDeposits()` controller calls `fetchExternalDeposits()`, which automatically selects between Alchemy or The Graph based on the configured provider.

Example logs:

```
[info] Using Alchemy as external deposits provider.
[info] Processed external deposits (alchemy). Inserted: 5. Skipped: 2.
```

## Notification Formatting

Deposit notifications use the token’s `display_decimals` field to ensure consistent precision:

```
Raw amount: 0.123456789
Display decimals: 2
Notification: "0.12 USDT"
```

**In short:**
Alchemy = real-time deposits, instant notifications, limited automation on the free plan.
The Graph = slow but reliable indexing for analytics and recovery.
