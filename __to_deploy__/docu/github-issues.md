# GitHub issues — Cardano

# 1. Backend — `ChatterPay-Backend`

**Title**

```
Add Cardano as a supported network
```

**Description**

```markdown
## Goal

Allow ChatterPay users to send and receive ADA and Cardano native tokens (USDCx, USDM,
USDA) through WhatsApp, the same way they already use EVM tokens.

## Scope

### Wallets
- Derive a Cardano wallet (Ed25519) for each user from the existing master secret.
- Show the Cardano address alongside the EVM address when the user asks for their wallet.
- Provision the Cardano wallet automatically on first interaction.

### Transfers
- Transfer ADA between ChatterPay users (phone to phone) and to external Cardano addresses.
- Transfer Cardano native tokens (USDCx, USDM, USDA) phone to phone and to external addresses.
- Calculate and charge the exact network fee (no gas estimation — Cardano fees are deterministic).

### Fee model
Cardano has no paymaster, so who covers the network fee is a deployment decision. Three
options controlled by environment variables:

| Mode | Who pays network fee | ChatterPay fee |
|---|---|---|
| A | User | None |
| B | User | 0.08 USD |
| **C (default)** | **ChatterPay (sponsor wallet)** | **0.08 USD** |

ChatterPay's fee (~0.46 ADA) is below the ledger minimum for a transaction output (~0.97
ADA), so it needs to accrue per user and be collected once it clears that minimum.

### Balance
- Return Cardano token balances in the existing balance endpoints.
- Filter out zero balances so empty Cardano wallets don't clutter the portfolio.

### Validation (before the operation lock)
- Reject amounts below the network minimum (~0.97 ADA).
- Reject insufficient funds, naming the exact amount needed and the address to fund.
- Reject the dust window (change below min-ADA would be burned) and suggest "send all".
- When sending a native token, require the ADA the network forces to travel with it.
  Keeping part of the token doubles that requirement.

### Notifications
- Include the Cardano address in the wallet creation notification.
- Explorer URL for Cardano transactions (Cardanoscan).

## Acceptance criteria
- A user can send ADA to another user by phone number and see the transaction on Cardanoscan.
- A user can send ADA to an external Cardano address.
- A user can send a native token (USDCx) to another user.
- Insufficient balance is rejected with a clear message before the lock.
- All three fee modes work and can be switched by environment variable.
```

---

# 2. Front — `ChatterPay-Front`

**Title**

```
Support Cardano in the dashboard
```

**Description**

```markdown
## Goal

Show Cardano balances, transaction history and transfer costs in the dashboard, so users
can manage ADA and Cardano native tokens the same way they manage EVM tokens.

## Scope

### Portfolio
- Show ADA and Cardano native token balances in the portfolio view.
- Empty Cardano wallets are already filtered out by the backend.

### Send flow
- Show the network fee on Cardano transfers (the backend returns `network_fee` and
  `network_fee_token` — on EVM the paymaster hides it, on Cardano the user pays it).
- Show the minimum balance required before a transfer can proceed, with a clear explanation.
  Sending a native token requires ~1.16 ADA attached to the token output. Keeping part of
  the token doubles that requirement.
- Offer a "send all" option — the user cannot compute the exact maximum without knowing
  the fee.
- Prevent amounts in the dust window (change below min-ADA would be silently burned).

### Transaction history
- Display Cardano transactions with the correct explorer link (Cardanoscan).

## Notes

The minimum figures depend on the backend's fee model configuration and should come from
the API, not be hardcoded.
```

---

# 3. Bot — `ChatBot-WhatsappOpenIA`

**Title**

```
Teach the bot about Cardano transfers
```

**Description**

```markdown
## Goal

Update the bot prompt so the assistant knows how to handle Cardano transfers and can
explain balance requirements to the user instead of letting transfers fail silently.

## What the prompt needs to cover

- **Cardano is a supported network.** Users can send ADA and native tokens (USDCx, USDM,
  USDA) by phone number or to an external Cardano address.
- **Fees are paid in ADA.** Depending on the deployment, ChatterPay may cover the fee or
  the user pays it. The assistant must never quote a specific fee amount.
- **Sending a token also requires ADA.** The network attaches ~1.16 ADA to the token
  output. Keeping part of the token doubles the requirement. A user with tokens and no ADA
  cannot transfer.
- **There is a minimum transfer amount** (~0.97 ADA) set by the network. Below it the
  whole transaction is rejected.
- **The backend returns error messages with the exact figures.** The assistant must relay
  them as-is, not invent a different explanation.

## Related

The prompt is truncated to `MAX_BASE_PROMPT_CHARS` (default 1800) while `chat_modes`
holds ~94,000 chars — anything past ~2% never reaches the model. The limit must be raised
for the Cardano section to be included. See `propuesta-tokens-prompt.md`.
```
