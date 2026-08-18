# GitHub issues — Cardano, trabajo pendiente

# 1. Backend — `ChatterPay-Backend`

**Title**

```
Add Cardano as a supported network 
```

**Description**

```markdown
Add Cardano as a new blockchain family in ChatterPay, alongside the existing EVM chains.
Users will be able to send and receive ADA and Cardano native tokens (USDCx, USDM, USDA)
through the same WhatsApp interface they already use for EVM tokens.

### What is already done

- Wallet derivation (Ed25519/HKDF, deterministic from the existing master secret)
- Base address generation (payment + staking credential, CIP-19)
- ADA transfers with exact fee calculation
- Native token transfers (multi-asset CBOR builder)
- Balance queries through Koios
- Wallet provisioning (atomic, idempotent)
- Notification templates with `[CARDANO_ADDRESS]`
- Blockchain and token catalogue entries for Preprod and mainnet

### What remains

- **Fee model configuration.** Cardano has no paymaster, so who covers the network fee is a
  deployment decision. Three options controlled by `CARDANO_SPONSOR_FEES` and
  `CARDANO_TRANSFER_FEE_USD`:

  | Sponsor | Fee USD | Result |
  |---|---|---|
  | off | 0 | A — user pays network fee, ChatterPay charges nothing |
  | off | 0.08 | B — user pays network fee + ChatterPay fee |
  | **on** | **0.08** | **C — ChatterPay covers network fee and charges its own** |

  Option C (sponsored transfers) is the default. The sponsor wallet is derived from the
  same master secret. Multi-input signing is implemented; deferred fee collection is not.

- **Deferred collection of ChatterPay's fee.** At USD 0.08 (~0.46 ADA) it is below the
  ledger's min-ADA (~0.97 ADA), so it cannot be a transaction output. It has to accrue per
  user and be collected when it clears the minimum (~3 transfers).

- **Pre-flight balance validation.** The required minimum depends on the fee model and the
  asset. Validation runs before the operation lock. Messages name exact figures.

  | Transfer | Options A/B | Option C |
  |---|---|---|
  | ADA | 1.135 ADA | 0.970 ADA |
  | Token (all) | 1.322 ADA | 0 |
  | Token (partial) | 2.482 ADA | 0 |

  The dust window (change below min-ADA) is rejected with a "send all" suggestion.

- **Live token transfer on Preprod** once USDCx test tokens are obtained.

Numbers measured against Preprod parameters (`minFeeA=44`, `minFeeB=155381`,
`coinsPerUtxoByte=4310`). See `opciones-fees-cardano.md`.
```

---

# 2. Front — `ChatterPay-Front`

**Title**

```
Cardano: display balances, fees and transfer limits
```

**Description**

```markdown
The dashboard needs to support Cardano alongside EVM chains. A user holding ADA or Cardano
tokens should see their balance, understand transfer costs, and know the minimum they need
before sending.

### What will be shown

- **Cardano balances** in the portfolio view (ADA and native tokens).
- **The network fee** on Cardano transactions. Transactions carry `network_fee` and
  `network_fee_token`. On EVM the paymaster hides the cost; on Cardano it is real money
  the sender paid.
- **Minimum balance to transfer**, in the send flow, with the reason. Sending a native
  token also requires ADA (~1.16 ADA attached to the token output). Keeping part of a
  token doubles the floor.
- **A "send all" option**, since the exact maximum depends on the fee.
- **The dust window** — the range where change would be below min-ADA and burned. The
  amount input must not let the user land there silently.

### Notes

Figures depend on the backend's fee model and should come from the API. Balances of zero
are filtered out, so an empty Cardano wallet shows the empty state — the address is
reachable through the deposit modal.
```

---

# 3. Bot — `ChatBot-WhatsappOpenIA`

**Title**

```
Cardano: update bot prompt with ADA transfer rules
```

**Description**

```markdown
The Cardano section of the prompt tells the assistant how to route a transfer, but not
what the user needs in their wallet before one can succeed. That gap shows up as a failed
transfer the assistant cannot explain.

### What the prompt needs

- **Fees are paid in ADA** and may come from the user's balance (depending on the fee
  model). The assistant must never quote a specific fee — the network decides it.
- **Sending a token requires ADA too.** The network attaches ~1.16 ADA to the token
  output. Keeping part of the token doubles the floor. A user with tokens and no ADA
  cannot transfer.
- **There is a minimum transfer amount** set by the network (~0.97 ADA), not by
  ChatterPay. Below it the whole transaction is rejected.
- **When ChatterPay charges a fee**, the recipient may receive less. The assistant must
  say so in the confirmation, not after.

The backend returns these conditions as HTTP 200 messages. The assistant must relay the
backend's text and not invent a different explanation — it names the exact figures.

### Related

The prompt is truncated to `MAX_BASE_PROMPT_CHARS` (default 1800) while `chat_modes`
holds ~94,000 chars. Anything past ~2% never reaches the model. Raising the limit costs
~25,000 tokens/call instead of ~2,800. See `propuesta-tokens-prompt.md`.
```
