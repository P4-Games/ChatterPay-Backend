/**
 * Cardano domain types.
 *
 * Kept apart from the EVM types on purpose: nothing here has an equivalent on the other side.
 * There is no nonce, no gas price and no relayer — a transfer is a set of unspent outputs turned
 * into new unspent outputs, and these are the shapes that describes.
 */

/**
 * Which Cardano network something belongs to.
 *
 * Never defaulted anywhere: the network travels inside the address itself (CIP-19), so a defaulted
 * value is how a testnet address becomes a mainnet one that nobody can spend from.
 */
export type CardanoNetwork = 'mainnet' | 'testnet';

/**
 * A native asset, identified the only way Cardano identifies one.
 *
 * There is no contract address: an asset *is* the pair (minting policy, name). Two tokens with the
 * same ticker and different policies are different assets, and confusing them does not fail — it
 * moves something the user did not mean to move.
 */
export interface CardanoAsset {
  /** Minting policy hash, 28 bytes, hex without `0x`. */
  policyId: string;
  /** Asset name, 0–32 bytes, hex without `0x`. Empty string is a valid name. */
  assetName: string;
}

/** A native asset and how much of it. */
export interface CardanoAssetAmount extends CardanoAsset {
  /** Quantity, in the asset's own base unit. */
  quantity: bigint;
}

/**
 * The concatenated `policyId + assetName`, which is how providers name an asset on the wire.
 *
 * @param asset - The asset.
 * @returns The unit string, lowercase.
 */
export function assetUnit(asset: CardanoAsset): string {
  return `${asset.policyId}${asset.assetName}`.toLowerCase();
}

/** An unspent output an address controls, as a provider reports it. */
export interface CardanoUtxo {
  /** Hash of the transaction that created the output, hex without `0x`. */
  txHash: string;
  /** Index of the output inside that transaction. */
  outputIndex: number;
  /** ADA held, in lovelace. */
  lovelace: bigint;
  /**
   * Whether the output also holds native assets.
   *
   * Kept alongside {@link assets} because it answers, without walking a list, the question coin
   * selection asks: reach for this one last. An ADA transfer can spend it — the change output
   * carries the tokens home — but doing so grows the transaction, so it is a last resort.
   */
  holdsOtherAssets: boolean;
  /**
   * The native assets this output holds. Empty or absent for a pure-ADA output.
   *
   * Populated only when the provider was asked for the detail. A token transfer needs it; an ADA
   * transfer does not, and asking for it costs a heavier provider response.
   */
  assets?: CardanoAssetAmount[];
  /**
   * Height of the block that created this output, when the provider reports one.
   *
   * Cardano puts no confirmation count on a UTxO, so this is what a depth threshold is resolved
   * against. Absent means the provider could not say, which is treated as "not deep enough" rather
   * than as "deep enough": the conservative reading is the only safe one when the question is
   * whether these funds can still disappear in a rollback.
   */
  blockHeight?: number;
}

/** The protocol parameters a transfer needs, read from the network rather than assumed. */
export interface CardanoProtocolParameters {
  /** Fee per byte of the serialized signed transaction. */
  minFeeA: number;
  /** Constant term of the fee. */
  minFeeB: number;
  /** Lovelace per byte of a UTxO, which is what sets the minimum an output may hold. */
  coinsPerUtxoByte: bigint;
  /** Ceiling on the serialized transaction size, in bytes. */
  maxTxSize: number;
}

/** What an address turned out to be, when it could be read at all. */
export interface DecodedCardanoAddress {
  /** The network the address belongs to, agreed between its prefix and its header byte. */
  network: CardanoNetwork;
  /**
   * High nibble of the header. `0` is the base address ChatterPay issues and the one every ordinary
   * wallet hands out; `1`–`3` are its script variants; `6` is an enterprise address, with no
   * staking part.
   */
  addressType: number;
  /** Hex of the payment credential: the 28 bytes right after the header, staking part excluded. */
  credentialHex: string;
  /**
   * Hex of the staking credential, for the address types that carry one (`0`–`3`). Absent for
   * enterprise addresses.
   *
   * Nothing in a transfer needs it — an output is paid to the whole address. It is read here for
   * what comes after: registering a stake key and delegating it both address the credential, not
   * the address.
   */
  stakeCredentialHex?: string;
  /**
   * The address exactly as it goes into a transaction output, header byte first. Decoded here
   * rather than re-derived by the transaction builder, so the bytes that get paid are the bytes
   * whose checksum was verified.
   */
  payload: Uint8Array;
}

/** A signature, as the signing boundary returns it. */
export interface CardanoVkeyWitness {
  /** Raw 32-byte Ed25519 public key, hex with or without `0x`. */
  publicKey: string;
  /** Raw 64-byte Ed25519 signature, hex with or without `0x`. */
  signature: string;
}

/** Everything a transaction build needs that does not come from the chain. */
export interface CardanoTransferPlan {
  /** Unspent outputs the sender holds. */
  utxos: readonly CardanoUtxo[];
  /** Raw bytes of the destination address, header included. */
  destinationAddress: Uint8Array;
  /** Raw bytes of the sender's address, where change goes. */
  changeAddress: Uint8Array;
  /**
   * Lovelace to send.
   *
   * For an ADA transfer this is the amount. For a native-asset transfer it is the ADA *attached* to
   * the token output — pass `0n` to let the builder attach the minimum the protocol requires, which
   * is what a user sending 30 USDM means.
   */
  amount: bigint;
  /**
   * A second wallet that covers the network fee, and the ADA a token drags with it.
   *
   * Cardano has no paymaster contract and it does not need one: a transaction may spend inputs from
   * several addresses and only requires a signature from each owner. So sponsoring is not a
   * mechanism to build, it is an input to add — and a second change output, because the sponsor's
   * leftover has to come back to the sponsor rather than be handed to the user.
   *
   * Absent means the sender pays for everything, which is what happens when sponsoring is off.
   */
  sponsor?: {
    /** Unspent outputs the sponsor offers. */
    utxos: readonly CardanoUtxo[];
    /** Raw bytes of the sponsor's address, where its change returns. */
    changeAddress: Uint8Array;
  };
  /**
   * Whether the sponsor also funds the ADA attached to the token output.
   *
   * Off, that ADA comes out of the sender's own inputs and their ADA balance falls by roughly 1.16
   * every time they move a token. On, the sponsor's inputs cover it and the sender's ADA balance
   * does not move — which is the whole of what scheme 2 buys.
   *
   * Expressed here as a capability rather than as a scheme number on purpose: the builder balances
   * a transaction, it has no business knowing which product decision put it in this mode.
   */
  sponsorMinAda?: boolean;
  /**
   * Whether change too small to be its own output is routed to the sponsor instead of refused.
   *
   * The remainder joins the sponsor's change output and is credited back to the user off-chain.
   * Costs nothing — the transaction only has to balance — and it is what lets a wallet holding
   * 10.5 send 10, which the ledger's floor otherwise forbids.
   *
   * Applies only when that change carries no tokens: residual assets have to come home to the
   * sender, so their output can never be routed away.
   */
  routeDustToSponsor?: boolean;
  /**
   * Outputs of the **destination** to fold into the one this transfer creates.
   *
   * A token transfer normally builds the recipient a new output, and a new output needs a new
   * min-ADA that somebody has to fund. When the recipient already holds this token, that ADA has
   * already been funded once: spending their output and reissuing one with both quantities in it
   * needs no new floor at all, because the floor is set by the output's size and an output holding
   * 15 of something is the same size as one holding 5.
   *
   * Only outputs whose sole asset is the token being sent belong here. One carrying anything else
   * would drag that into the destination's new output — harmless, since it is going back to its own
   * owner, but it changes the floor and it is not this transfer's business to move.
   *
   * Spending them needs the destination's signature, so a plan that sets this must also count it in
   * {@link witnessCount}.
   */
  recycleUtxos?: readonly CardanoUtxo[];
  /**
   * ChatterPay's fee for this transfer, **in the units of whatever is moving** — lovelace on an ADA
   * transfer, the asset's own base units on a token transfer.
   *
   * Taken out of {@link amount} rather than charged on top of it, which is what EVM does and what
   * makes `amount − fee` the figure that actually arrives. It needs no output of its own: it rides
   * in the sponsor's change, which already exists in every sponsored transfer and is far above the
   * floor an output has to clear. That is the whole reason the fee can be charged every time
   * instead of being accrued until it grows past min-ADA.
   *
   * Requires a sponsor. Without one there is no change output to fold it into, and it is dropped.
   */
  chatterPayFee?: bigint;
  /**
   * The native asset being sent, when this is a token transfer.
   *
   * Absent for ADA. One asset per transfer: that is what the product asks for, and it keeps
   * selection tractable. The *change* may still carry several, because the inputs chosen to cover
   * this one may hold others.
   */
  asset?: CardanoAssetAmount;
  /** Slot after which the transaction expires. */
  ttlSlot: number;
  /** Protocol parameters in force. */
  parameters: CardanoProtocolParameters;
  /** How many keys will sign. Decides the witness bytes the fee is charged for. */
  witnessCount: number;
}

/** A transfer, built and ready to be signed. */
export interface BuiltCardanoTransaction {
  /** Serialized `transaction_body`: the bytes the signature is made over. */
  bodyBytes: Uint8Array;
  /** blake2b-256 of {@link bodyBytes}: the transaction id, hex without `0x`. */
  transactionId: string;
  /** Fee this transaction pays, in lovelace. Exact, not an estimate. */
  fee: bigint;
  /**
   * Lovelace that actually leaves for the destination.
   *
   * Equal to the requested amount on an ADA transfer. On a token transfer it is the ADA attached to
   * the token output — money that really leaves the sender and arrives at the recipient, so the
   * reconciliation invariant is stated against this and never against "what was asked for".
   */
  sentLovelace: bigint;
  /** Change returned to the sender, in lovelace. Zero when there is no change output. */
  change: bigint;
  /**
   * Native assets returned to the sender in the change output.
   *
   * Whatever the selected inputs held minus what was sent. Unlike dust ADA, residual tokens can
   * never be dropped into the fee: a transaction that does not return them does not balance, and
   * the ledger rejects it.
   */
  changeAssets: readonly CardanoAssetAmount[];
  /** The outputs selected as inputs, in the order they appear in the body. */
  inputs: readonly CardanoUtxo[];
  /**
   * Where the sender's change sits among the outputs, or `undefined` when there is none.
   *
   * Reported rather than left to be recomputed by the caller: together with {@link transactionId} it
   * names the output this transaction is about to create, which is what lets the next transfer spend
   * it before any provider has indexed it.
   */
  changeIndex?: number;
  /**
   * Where the sponsor's change sits among the outputs, or `undefined` when there is none.
   *
   * The sponsor spends and re-receives its own outputs on every sponsored transfer, so it runs into
   * the unindexed-change problem sooner than any user does: reported for the same reason as
   * {@link changeIndex}.
   */
  sponsorChangeIndex?: number;
  /** Slot after which the network stops accepting this transaction. */
  ttlSlot: number;
  /**
   * ChatterPay fee actually charged, in the units of whatever moved.
   *
   * Zero when nothing was charged — no sponsor to fold it into, or none asked for. Deducted from
   * the amount, so what reached the destination is the amount minus this.
   */
  chatterPayFee: bigint;
  /**
   * Sender lovelace that rode home in the sponsor's change instead of the sender's own, because it
   * was below the floor an output has to clear.
   *
   * Zero on every transfer that did not need it, which is most of them. When it is not zero it is a
   * debt: the money left the sender's address, it is sitting in ChatterPay's, and the sender has to
   * be credited for it. Reported rather than folded into the fee so that the credit has a figure to
   * be made from and reconciliation can find it.
   */
  routedToSponsor: bigint;
  /**
   * Native assets riding home in the sponsor's change output.
   *
   * ChatterPay's fee on a token transfer, and empty on every other kind. Reported for the same
   * reason {@link changeAssets} is: the caller records this output so the next transfer can spend it
   * before any provider has indexed it, and an output recorded as pure ADA when it carries a token
   * gets spent as pure ADA — which builds a transaction that does not conserve value and that the
   * chain rejects.
   */
  sponsorChangeAssets: readonly CardanoAssetAmount[];
  /**
   * Lovelace the sponsor put into outputs that are not its own.
   *
   * The min-ADA attached to the token output, under scheme 2. It is what the sponsor gave away on
   * this transfer, as opposed to the network fee it burned, and the two are worth telling apart:
   * this one lands in a user's wallet and never comes back.
   */
  sponsorSuppliedLovelace: bigint;
  /**
   * Lovelace that came from the destination's own recycled outputs.
   *
   * It is part of {@link sentLovelace} — it sits in the output being paid — but it never belonged to
   * the sender and never left their wallet. Without it, "what the sender put in" reads as the whole
   * of the destination's balance being spent and reissued, which is exactly what recycling does and
   * exactly what it must not be reported as.
   */
  recycledLovelace: bigint;
}

/** A wallet's Cardano identity: the address, its raw bytes, and the key behind it. */
export interface CardanoAccount {
  /** The bech32 address, `addr_test1…` on testnet and `addr1…` on mainnet. */
  address: string;
  /** The address as it goes into a transaction output, header byte first. */
  addressBytes: Uint8Array;
  /** Raw 32-byte Ed25519 payment public key, hex with `0x`. This is the one that signs. */
  publicKey: string;
  /**
   * Raw 32-byte Ed25519 staking public key, hex with `0x`.
   *
   * Present in every address this deployment issues, and registered in none of them. It signs
   * nothing today: a transfer is authorised by the payment key alone. It exists so that delegating
   * later is a certificate rather than a new address.
   */
  stakePublicKey: string;
}

/**
 * Cardano settings as the environment holds them.
 *
 * For the numbers, `null` means "not configured", never "zero": the defaults are declared in
 * `cardanoConfig.ts` alongside the reasoning for each one, so the reader validates without
 * deciding. The strings say the same thing with `''`.
 */
export interface CardanoEnv {
  /** Whether the family was switched on. Not whether it is usable — that is a conclusion. */
  enabled: boolean;
  /** Network as written, trimmed. Resolving the spelling is the caller's job. */
  network: string;
  /** Explicit chain id, when one was set. */
  chainId: number | null;
  /** Provider root as configured. Stripping its trailing slashes is the caller's job, so that a
   *  value of nothing but slashes still reads as a value and not as an absent one. */
  providerUrl: string;
  /**
   * Provider credential as configured, trimmed.
   *
   * What it stands for depends on the provider the root URL names — a Blockfrost project id, a
   * Koios bearer token — which is why one setting serves both: a deployment swaps providers by
   * changing the URL, and the credential follows it.
   */
  providerApiKey: string;
  /** Per-call ceiling for provider requests, in milliseconds. */
  providerTimeoutMs: number | null;
  /** Slots of validity given to a transaction, from the tip. */
  ttlSlots: number | null;
  /** Confirmations required before an output is spendable. */
  depositConfirmations: number | null;
  /** Explorer base URL. */
  explorerUrl: string;
  /** Whether the master secret every wallet derives from is present. */
  hasSecret: boolean;
  /** Whether every derivation label is present and readable. */
  labelsReadable: boolean;
}

/** Who pays what on a Cardano transfer, as the environment holds it. */
export interface CardanoFeeEnv {
  /** Whether ChatterPay was asked to cover the network fee. */
  sponsorFees: boolean;
  /** ChatterPay's fee per transfer, in USD. Scheme 1 reads this one. */
  transferFeeUsd: number | null;
  /** ChatterPay's fee per transfer, in ADA. Scheme 2 reads this one. */
  transferFeeAda: number | null;
  /** ChatterPay's fee, in ADA, when it also has to fund a new min-ADA for the destination. */
  transferFeeAdaNewOutput: number | null;
  /** Which fee scheme was asked for, as configured. Anything but `2` resolves to scheme 1. */
  feeScheme: number | null;
  /** Whether the destination's existing token output may be recycled. Scheme 2 only. */
  recycleDestinationUtxo: boolean;
  /** Whether change below the ledger's floor is routed to the sponsor. Scheme 2 only. */
  routeDustToSponsor: boolean;
  /** Identifier the sponsor wallet derives from. */
  sponsorWalletId: string;
}

/**
 * Why the family is off, as a code.
 *
 * A code rather than a sentence, and deliberately without the name of the setting behind it: this
 * value travels into the message a caller shows the user, and a sentence naming the variable that
 * is missing describes this deployment's configuration to anybody who pokes the endpoint. The
 * operator reads the same code in the log and knows what to look at.
 *
 * - `flag_off` — the family was not switched on.
 * - `network_unknown` — the configured network is not one this deployment can read.
 * - `provider_missing` — a provider root was configured, and it resolved to nothing.
 * - `provider_key_missing` — the configured provider needs a credential, and none was set.
 * - `secret_missing` — the master secret every wallet derives from is absent.
 * - `labels_unreadable` — one of the configured derivation labels is absent or not readable.
 */
export type CardanoDisabledReason =
  | ''
  | 'flag_off'
  | 'network_unknown'
  | 'provider_missing'
  | 'provider_key_missing'
  | 'secret_missing'
  | 'labels_unreadable';

/**
 * The hosted providers this deployment can read the chain through.
 *
 * Not a setting of its own: it is read off the provider root URL, so swapping providers is one
 * line of configuration and not two that can disagree. A URL naming neither is treated as Koios,
 * which is the dialect the default roots speak.
 */
export type CardanoProviderKind = 'koios' | 'blockfrost';

/** Everything the Cardano subsystem needs to run, resolved once. */
export interface CardanoConfig {
  /** Whether the family is fully configured and may be used. */
  enabled: boolean;
  /** The network this deployment operates on. Decides the header byte of every address it issues. */
  network: CardanoNetwork;
  /** Internal chain id of that network. */
  chainId: number;
  /** Provider root URL. */
  providerUrl: string;
  /** Which provider dialect that root speaks, and so which client reads it. */
  providerKind: CardanoProviderKind;
  /** Credential sent with every provider call. Empty when the provider needs none. */
  providerApiKey: string;
  /** Per-call ceiling for provider requests, in milliseconds. */
  providerTimeoutMs: number;
  /** Slots of validity given to a transaction, from the tip. */
  ttlSlots: number;
  /** Confirmations required before an output is spendable. */
  depositConfirmations: number;
  /** Explorer base URL; the transaction id is appended directly. */
  explorerUrl: string;
  /** Why the family is off, when it is. Empty when enabled. */
  disabledReason: CardanoDisabledReason;
}

/**
 * Why sponsoring is off, as a code.
 *
 * A code rather than a sentence naming the setting behind it, for the same reason as
 * `CardanoDisabledReason`: this value travels towards the caller, and the name of a missing
 * variable describes this deployment's configuration to whoever reads the answer.
 */
export type CardanoSponsorDisabledReason = '' | 'sponsor_wallet_missing';

/**
 * Which of the two fee schemes a deployment runs.
 *
 * - `1` — the sender supplies the ADA a token drags along, and ChatterPay's fee is priced in USD.
 *   What the wallet shows after sending a token is the token leaving *and* min-ADA leaving, because
 *   that ADA is the sender's and it moves to the recipient.
 * - `2` — ChatterPay supplies that ADA, and its fee is priced in ADA. The sender's ADA balance does
 *   not move when they send a token, and the figure on screen is one number rather than two.
 *
 * They are a switch rather than a migration because scheme 2 changes who funds an output, which is
 * the part of the builder where a mistake produces transactions the chain rejects. Being able to go
 * back to 1 without a deploy is the point.
 */
export type CardanoFeeScheme = 1 | 2;

/** ChatterPay's fee cannot be a Cardano output of its own: it is below the ledger's min-ADA. */
export interface CardanoFeeConfig {
  /** Which scheme this deployment runs. */
  scheme: CardanoFeeScheme;
  /** Whether ChatterPay supplies an input to cover the network fee. */
  sponsorNetworkFee: boolean;
  /**
   * Whether ChatterPay also supplies the min-ADA the token output must carry.
   *
   * Scheme 2 with a usable sponsor, and nothing else: without a sponsor there is no second wallet
   * to supply it from, and under scheme 1 that ADA is the sender's by design.
   */
  sponsorMinAda: boolean;
  /**
   * Whether change too small to stand as its own output is routed to the sponsor.
   *
   * Only when it carries no tokens. A change output holding the sender's residual assets has to go
   * to the sender: routing it would hand ChatterPay their token.
   *
   * **Its own setting, and off by default, because it moves the user's money.** The routed lovelace
   * leaves their address and sits in ChatterPay's, and it is theirs: turning this on without the
   * credit that gives it back turns an honest refusal — "your change would be lost" — into a silent
   * charge of up to one min-ADA. Switch it on when the crediting exists, not before.
   */
  routeDustToSponsor: boolean;
  /**
   * Whether a destination output already holding this token may be spent and reissued as one.
   *
   * Its own setting rather than part of the scheme, because it brings a third signature and a
   * third claim to race on, and that is worth being able to switch off without going back to
   * scheme 1 wholesale.
   */
  recycleDestinationUtxo: boolean;
  /** ChatterPay's fee per transfer, in USD. Scheme 1. Zero disables charging entirely. */
  transferFeeUsd: number;
  /** ChatterPay's fee per transfer, in ADA. Scheme 2. Zero disables charging entirely. */
  transferFeeAda: number;
  /**
   * ChatterPay's fee, in ADA, on the one transfer that costs it more than the network fee.
   *
   * A token going to somebody who does not hold it yet needs a brand new output, and under scheme 2
   * ChatterPay funds its min-ADA — roughly 1.16 ADA that lands in the recipient's wallet and does
   * not come back. The ordinary fee does not cover that, so this one is charged instead.
   *
   * It is the exception that keeps the headline number small: every other transfer, including one
   * to somebody who already holds the token, pays {@link transferFeeAda}.
   */
  transferFeeAdaNewOutput: number;
  /**
   * Identifier the sponsor wallet derives from, when sponsoring is on.
   *
   * Derived like any other wallet rather than configured as a private key: the same master secret
   * produces it, so there is no second secret to distribute, rotate or leak.
   */
  sponsorWalletId: string;
  /** Why sponsoring is off, when it is configured on but unusable. Empty when nothing is wrong. */
  disabledReason: CardanoSponsorDisabledReason;
}

/** What the startup derivation check concluded. */
export type CardanoDerivationCheck =
  | { status: 'ok'; address: string }
  | { status: 'skipped'; detail: string }
  | { status: 'unrecorded'; address: string }
  | { status: 'changed'; expected: string; derived: string };

/**
 * Why a transfer was refused, in a form that can still be said in the user's language.
 *
 * The services that decide this are arithmetic: floors, fees and balances. What they must not do is
 * write the sentence, because the sentence has to arrive in the language the user talks to the bot
 * in, and that language is read from the user's settings by the notification layer. A service that
 * returns prose has already chosen a language for everybody.
 *
 * So the refusal travels as a reason plus the figures it names, and the controller renders it from
 * the localized template, exactly as the EVM path renders `amount_outside_limits`.
 */
export type CardanoRefusalReason =
  /** The amount is under the ledger's own floor for an output. */
  | 'amount_below_minimum'
  /** The wallet holds less ADA than the transfer needs. */
  | 'insufficient_ada'
  /** The change output carries tokens, so its floor can never leave with the transfer. */
  | 'change_carries_tokens'
  /** The change this transfer would leave is below the floor, and the network would absorb it. */
  | 'change_below_floor'
  /** A token transfer needs ADA of its own, which this wallet does not hold. */
  | 'token_needs_ada'
  /**
   * The same, when the sender keeps part of the token.
   *
   * Its own sentence because the figure is roughly double for a reason the user can act on: the
   * change that keeps the rest of the token needs a floor of its own, and sending the whole balance
   * does not.
   */
  | 'token_needs_ada_keeping_rest'
  /** Sending part of a token needs the floor of the change that keeps the rest. */
  | 'token_change_needs_ada'
  /** The wallet holds less of the token than the user asked to send. */
  | 'token_balance_not_enough'
  /** The amount does not exceed ChatterPay's fee, so nothing would reach the destination. */
  | 'amount_below_fee'
  /** ChatterPay cannot cover the network fee right now. */
  | 'sponsor_unavailable'
  /** Discovered inside the transfer: the wallet has to be funded before this can work. */
  | 'insufficient_funds';

/** A refusal the user is going to read, before it has been put into words. */
export interface CardanoRefusal {
  /** Which sentence to say. */
  reason: CardanoRefusalReason;
  /**
   * The figures that sentence names, keyed by the placeholder they replace.
   *
   * Bracketed keys (`[HELD]`) for the same reason the EVM templates use them: the value is
   * substituted into a string a non-developer edits in Mongo.
   */
  params: Readonly<Record<string, string>>;
}
