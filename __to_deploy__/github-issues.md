# GitHub issues — Cardano, trabajo pendiente

Uno por repo. Copiar título y descripción.

---

# 1. Backend — `ChatterPay-Backend`

**Title**

```
Support the three Cardano fee models behind environment variables, defaulting to sponsored transfers
```

**Description**

```markdown
Cardano has no paymaster contract and fees can only be paid in ADA, so who pays what
has to become a deployment decision rather than something baked into the transfer path.

Two independent settings will control it:

| `CARDANO_SPONSOR_FEES` | `CARDANO_TRANSFER_FEE_USD` | Result |
|---|---|---|
| `false` | `0` | Option A — the user pays the network fee, ChatterPay charges nothing |
| `false` | `0.08` | Option B — the user pays the network fee and owes ChatterPay's fee |
| `true` | `0.08` | **Option C** — ChatterPay covers the network fee and charges its own |
| `true` | `0` | ChatterPay covers the network fee and charges nothing |

A third variable, `CARDANO_SPONSOR_WALLET_ID`, will identify the wallet that funds the
sponsored transfers. It will be derived from the existing master secret like any other
wallet, so no second secret has to be distributed or rotated. Sponsoring will report
itself off, with an explicit reason, when it is switched on without that wallet.

### What has to be built

- **Multi-source inputs in the transaction builder.** This is the only part of option C
  that does not exist today: the builder takes UTxOs from a single wallet. A Cardano
  transaction accepts inputs from several addresses and only needs a signature from each
  owner, and ChatterPay already signs for the user, so this changes no trust boundary. It
  costs ~0.004 ADA of extra network fee.
- **Deferred collection of ChatterPay's fee.** At USD 0.08 the fee is ~0.46 ADA, which is
  below the ledger's min-ADA (~0.97 ADA), so it cannot be an output of its own — a
  transaction carrying one is rejected outright. The fee will accrue per user and be
  collected as an extra output on a later transfer, once the accrued total clears the
  minimum (three transfers). What happens to an unpaid balance when a user stops
  transferring still has to be decided.
- **Pre-flight balance validation, before the operation lock is taken.** The required
  minimum depends on the mode and on the asset, and the message must name the exact
  figures. Today a user finds out after the lock, the notification and the optimistic
  answer have already gone out.

### Minimums the validation has to enforce

| To transfer | A and B | C |
|---|---|---|
| ADA | 1.135119 ADA | 0.969750 ADA |
| USDCx, sending the whole balance | 1.322341 ADA | 0 |
| USDCx, sending part of it | 2.482173 ADA | 0 |

The last row is the non-obvious one: when the sender keeps part of a native asset, their
own change output carries the remainder and needs min-ADA too, so **the floor is paid
twice**. A token never travels alone.

The validation must also reject the dust window — the range just below "send everything"
where the change would fall under min-ADA and be burned as fee — and offer "send all" as a
valid amount, since the user cannot compute it themselves without knowing the fee.

### Response contract

Every failure must answer HTTP 200 with the message in the body. The caller is a bot and a
response without a body leaves the conversation waiting forever, which is worse than any
error text.

### Tests

The three options have to be exercised, not just the default: minimum enforcement,
the dust window, the deferred fee reaching the collection threshold, and a sponsored
transfer with two signatures. Option C will be left configured as the default once all
three pass.

Numbers above were measured against Preprod protocol parameters
(`minFeeA=44`, `minFeeB=155381`, `coinsPerUtxoByte=4310`) with base addresses.
See `__to_deploy__/opciones-fees-cardano.md`.
```

---

# 2. Front — `ChatterPay-Front`

**Title**

```
Show Cardano network cost and minimum-balance requirements in the dashboard
```

**Description**

```markdown
Cardano charges the sender directly rather than through a paymaster, and the ledger puts a
floor under every output. Neither is visible in the dashboard today, so a user can hold ADA
and still be unable to send it without understanding why.

### What will be shown

- **The network fee on a Cardano transaction.** Transactions already carry `network_fee`
  and `network_fee_token`, separate from `fee` (ChatterPay's fee, charged in the token
  moved). On EVM the paymaster absorbs the network cost and the user never sees it; on
  Cardano it is real money the sender paid, and a history showing only `fee` hides it.
- **The minimum a wallet needs before it can transfer**, in the withdraw flow, with the
  reason. Sending ADA needs the amount plus the network fee; sending a native asset such
  as USDCx also needs ADA — the network requires ~1.16 ADA to travel attached to the token
  output, and if the sender keeps part of the token their own change needs the same floor
  again. A user holding USDCx and no ADA cannot transfer at all.
- **A "send all" option**, since the exact maximum depends on a fee the user cannot know
  in advance.
- **The dust window.** Between "keep at least the minimum" and "send everything" there is a
  ~1.14 ADA band where the change would fall below the ledger floor and be burned as fee.
  The amount input should not let the user land there silently.

### Notes

The figures depend on the fee model the backend is configured with, so they should come
from the API rather than be hardcoded in the client. The backend issue tracks exposing
them.

Balances of zero are already filtered out of the response for both families, so an empty
Cardano wallet shows the empty state rather than an "ADA 0" row — the address stays
reachable through the deposit modal, which is where a user goes to fund it.
```

---

# 3. Bot — `ChatBot-WhatsappOpenIA`

**Title**

```
Explain Cardano balance requirements and fee model in the assistant prompt
```

**Description**

```markdown
The Cardano section of the prompt tells the assistant how to route a transfer, but not what
the user needs in their wallet before one can succeed. That gap shows up as a failed
transfer the assistant cannot explain, or as an amount the user is told will arrive and
does not.

### What the prompt will have to state

- **Fees on Cardano are paid in ADA and, depending on the deployment, may come out of the
  user's own balance.** Unlike EVM transfers, where ChatterPay covers the network cost, on
  Cardano the sender can be paying it directly. The assistant must never quote or promise a
  specific fee amount: it is decided by the network when the transaction is built.
- **Sending a Cardano token that is not ADA also requires ADA.** The network makes a
  minimum amount of ADA travel attached to the token output, and if the sender keeps part
  of the token, that floor applies a second time to their own change. A user holding USDCx
  and zero ADA cannot transfer.
- **There is a minimum transfer amount set by the network, not by ChatterPay.** Below it the
  ledger rejects the whole transaction rather than the payment.
- **When ChatterPay charges its own fee, the recipient may receive less than the stated
  amount**, and the assistant has to say so in the confirmation summary rather than let the
  difference surface afterwards.

The backend returns these conditions as a message with HTTP 200 precisely so the assistant
can relay them. It must relay the backend's own text and must not invent a different
explanation — the message names the exact figures and, for insufficient funds, the address
to fund.

### Related

A separate concern worth resolving alongside this: the prompt is truncated to
`MAX_BASE_PROMPT_CHARS` (default 1800) while `chat_modes` holds ~94,000 characters, so
anything past the first ~2% never reaches the model. Raising the limit makes each call cost
~25,000 tokens instead of ~2,800. See `__to_deploy__/propuesta-tokens-prompt.md` in the
backend repository for the measurements and a plan.
```
