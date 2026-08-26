/**
 * The Cardano transfer: select inputs, pay the exact fee, sign, submit.
 *
 * The shape of this flow is not EVM's, and the reason is the account model. There is no nonce, no
 * gas price, no relayer and no paymaster: a transfer is a set of unspent outputs turned into new
 * unspent outputs, and the fee comes out of the sender's own inputs.
 *
 * **Every refusal happens before the signature.** A transaction that cannot pay its fee, a
 * destination on the wrong network, an amount below the minimum an output may hold — all of them
 * fail while nothing has been sent anywhere, because Cardano offers no way to replace or cancel a
 * submitted transaction and the only clean failure is one that never left.
 *
 * **The fee is exact, not estimated.** It is computed from the serialized size of the very
 * transaction being submitted, so what gets reported is what the chain charged rather than a guess
 * with a margin.
 */

import { chargesTransferFee, getCardanoFeeConfig } from '../../config/cardanoFeeConfig';
import { Logger } from '../../helpers/loggerHelper';
import type {
  CardanoAccount,
  CardanoAssetAmount,
  CardanoNetwork,
  CardanoUtxo
} from '../../types/cardanoType';
import { decodeCardanoAddress } from './cardanoAddressService';
import { chatterPayFeeUnits } from './cardanoFeeService';
import {
  type CardanoProvider,
  CardanoProviderError,
  logCardanoProviderError
} from './cardanoProviderService';
import { cardanoSignerService } from './cardanoSignerService';
import {
  assetBalance,
  buildCardanoTransfer,
  encodeSignedTransaction,
  selectableBalance,
  spendableBalance
} from './cardanoTxService';
import {
  claimUtxos,
  forgetPendingChange,
  outpointOf,
  ownTransactionsAmong,
  pendingChangeFor,
  recordOwnTransaction,
  recordPendingChange,
  releaseUtxos,
  unclaimedUtxos
} from './cardanoUtxoClaimService';

/** Everything a transfer needs to be attempted. */
export interface CardanoTransferInput {
  /** Phone number of the sender: the identity the signing key derives from. */
  fromPhoneNumber: string;
  /**
   * Ticker of what is moving — `ADA`, or the token's symbol.
   *
   * Here to price ChatterPay's fee, which is charged in whatever is being sent rather than always
   * in ADA. Required rather than defaulted: a caller that forgets it would silently move the charge
   * onto the wrong asset.
   */
  tokenSymbol: string;
  /** Decimals that ticker carries. */
  tokenDecimals: number;
  /** Bech32 destination address. */
  toAddress: string;
  /**
   * Lovelace to send.
   *
   * For an ADA transfer this is the amount. For a native-asset transfer, pass `0n` to attach the
   * protocol minimum to the token output — which is what "send 30 USDM" means.
   */
  amountLovelace: bigint;
  /**
   * The native asset being sent, when this is not an ADA transfer.
   *
   * The ADA that travels with it is not a fee and is not optional: a Cardano output carries a
   * value, and a token cannot sit in one alone.
   */
  asset?: CardanoAssetAmount;
  /** Provider to read and submit through. */
  provider: CardanoProvider;
  /** Network the transfer settles on. */
  network: CardanoNetwork;
  /** Internal chain id of that network. */
  chainId: number;
  /** Slots of validity, counted from the tip. */
  ttlSlots: number;
  /** Confirmations required before an input is spendable. */
  depositConfirmations: number;
  /** Explorer base URL; the transaction id is appended directly. */
  explorerUrl: string;
  /** Correlation key for the logs of this operation. */
  logKey: string;
}

/** What a transfer produced, successful or not. */
export interface CardanoTransferResult {
  success: boolean;
  /** Transaction id, hex without `0x`. Empty when nothing was submitted. */
  transactionHash: string;
  /** Network fee actually paid, in lovelace. `0n` when nothing was submitted. */
  feeLovelace: bigint;
  /**
   * Lovelace that left for the destination.
   *
   * On a token transfer this is the ADA the protocol forces to travel with the token — worth
   * surfacing, because the sender's ADA balance drops by more than the fee and nothing else would
   * explain it.
   */
  sentLovelace: bigint;
  /** Explorer link to the transaction. Empty when nothing was submitted. */
  explorerUrl: string;
  /**
   * ChatterPay's fee for this transfer, **in the units of whatever moved**.
   *
   * Deducted from the amount, so the destination received the amount less this. Zero when nothing
   * was charged.
   */
  chatterPayFee: bigint;
  /** Machine-readable failure code, empty on success. */
  errorCode: string;
  /** Human-readable failure detail, empty on success. */
  error: string;
}

/**
 * What the user is told when the chain could not be reached.
 *
 * A sentence rather than the code behind it: this text is delivered as a chat message, and a person
 * reading `CARDANO_PROVIDER_TIMEOUT` learns nothing they can act on. The code is in the log.
 */
const PROVIDER_UNREACHABLE =
  'We could not reach the Cardano network. Please try again in a few minutes.';

/**
 * What the user is told when ChatterPay cannot cover the fee right now.
 *
 * Exported because the preflight answers the same question before the lock is taken, and two
 * copies of a sentence the user reads are two sentences that drift apart.
 */
export const SPONSOR_UNAVAILABLE =
  'We could not process the transfer right now. Please try again in a few minutes.';

/**
 * What the user is told when another transfer got to the outputs first.
 *
 * Worth its own sentence rather than the generic failure: this one clears by itself in seconds, and
 * telling somebody to try again in a moment is true here in a way it is not for the rest.
 */
const TRANSFER_BUSY = 'Another transfer of yours is still settling. Try again in a few seconds.';

/** What the user is told when the failure is one nobody anticipated. */
const TRANSFER_FAILED = 'We could not complete the transfer. Please try again in a few minutes.';

/** A failure that happened before anything was signed, and therefore costs nothing to report. */
class CardanoTransferRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CardanoTransferRefusal';
  }
}

function failure(code: string, message: string): CardanoTransferResult {
  return {
    success: false,
    transactionHash: '',
    feeLovelace: 0n,
    sentLovelace: 0n,
    chatterPayFee: 0n,
    explorerUrl: '',
    errorCode: code,
    error: message
  };
}

/**
 * Submits, and resolves the one outcome that is neither success nor failure.
 *
 * A submit that times out may already be on chain. Sending it again would be a second transaction
 * spending the same inputs — one of the two would be rejected, but which one is not this process's
 * to decide, and the operation would end up reported against a transaction id that lost. So the
 * timeout is resolved by looking up the id, which is known before submission because it is the hash
 * of the body that was signed.
 *
 * @param provider - Provider to submit through.
 * @param signedCborHex - The serialized signed transaction.
 * @param expectedId - The transaction id computed locally from the signed body.
 * @param logKey - Correlation key for the logs.
 * @returns The transaction id on chain.
 * @throws CardanoProviderError When the chain rejected it, or when the outcome stays unknown.
 */
async function submitResolvingTimeout(
  provider: CardanoProvider,
  signedCborHex: string,
  expectedId: string,
  logKey: string
): Promise<string> {
  try {
    return await provider.submit(signedCborHex);
  } catch (error) {
    if (!(error instanceof CardanoProviderError) || !error.undetermined) throw error;
    Logger.warn(
      'cardanoTransfer',
      logKey,
      `Submit outcome undetermined, resolving by lookup of ${expectedId}`
    );
    const status = await provider.statusOf(expectedId);
    if (status.known) {
      Logger.info('cardanoTransfer', logKey, `Transaction ${expectedId} did reach the chain`);
      return expectedId;
    }
    // A refusal rather than a provider error, because the outcome is now known and the sentence
    // below is the one the user needs. The provider's own text stays in the log: it names the host
    // that failed and quotes its response, neither of which is the user's to read.
    Logger.warn('cardanoTransfer', logKey, `Submit failed outright: ${error.message}`);
    throw new CardanoTransferRefusal(
      `CARDANO_PROVIDER_${error.failure.toUpperCase()}`,
      `transaction ${expectedId} is not on chain; it is safe to retry`
    );
  }
}

/**
 * Everything the sponsor can spend right now.
 *
 * The provider's answer plus the change of transactions already submitted, which it cannot report
 * yet. Deduplicated by outpoint so an output that has since been indexed appears once, with the
 * provider's version winning.
 *
 * @param provider - Provider to read from.
 * @param address - The sponsor's address.
 * @returns Outputs available to fund a fee.
 */
async function sponsorHoldings(provider: CardanoProvider, address: string): Promise<CardanoUtxo[]> {
  const held = await provider.utxosFor(address);
  return [...held, ...(await spendablePendingChange(provider, address, held))];
}

/**
 * Pending change that is still worth offering.
 *
 * A pending output is only a promise until the chain has it, and the promise expires in two ways.
 * The obvious one is that the transaction never landed. The other is that the output landed and was
 * then spent by something outside this flow, which leaves the record describing an outpoint that no
 * longer exists — and spending an input that does not exist is rejected outright.
 *
 * Both are the same question: has the transaction reached a block yet? If it has, then whatever the
 * provider reports about that address is the truth, and an output missing from it is one that has
 * been spent. If it has not -- unknown, or known with no confirmations, which is a mempool and not a
 * block -- the transaction is still in flight and its change is the best information available.
 *
 * The distinction between "known" and "in a block" is the whole of it: an indexer cannot list an
 * output whose transaction it has not indexed, so treating a mempool sighting as proof would discard
 * every promise the moment it was made.
 *
 * @param provider - Provider to ask.
 * @param address - The address whose pending change is being weighed.
 * @param held - What the provider reports the address holds right now.
 * @returns The pending outputs that are still plausible, with the rest forgotten.
 */
async function spendablePendingChange(
  provider: CardanoProvider,
  address: string,
  held: readonly CardanoUtxo[]
): Promise<CardanoUtxo[]> {
  const pending = await pendingChangeFor(address);
  if (pending.length === 0) return [];

  const seen = new Set(held.map(outpointOf));
  const usable: CardanoUtxo[] = [];
  const stale: string[] = [];

  for (const utxo of pending) {
    // Already reported by the provider: the record has served its purpose and the real one wins.
    if (seen.has(outpointOf(utxo))) {
      stale.push(outpointOf(utxo));
      continue;
    }
    let inABlock = false;
    try {
      const status = await provider.statusOf(utxo.txHash);
      inABlock = status.known && status.confirmations >= 1;
    } catch {
      // Unreachable provider is not evidence either way. Keeping the output is the safer guess: it
      // was promised by a transaction this deployment submitted.
      usable.push(utxo);
      continue;
    }
    if (inABlock) stale.push(outpointOf(utxo));
    else usable.push(utxo);
  }

  await forgetPendingChange(stale);
  return usable;
}

/**
 * Sends ADA from a user's derived address to a Cardano destination.
 *
 * @param input - Sender, destination, amount and the chain settings to use.
 * @returns The submitted transaction and the fee it really paid, or a classified failure. Never
 *   throws: the caller is a request handler that has already told the user the operation started.
 */
export async function executeCardanoTransfer(
  input: CardanoTransferInput
): Promise<CardanoTransferResult> {
  const {
    fromPhoneNumber,
    toAddress,
    amountLovelace,
    provider,
    network,
    chainId,
    ttlSlots,
    depositConfirmations,
    explorerUrl,
    logKey
  } = input;

  let account: CardanoAccount | undefined;
  // Held outside the try so the claims can be given back on the paths that end without a
  // transaction on chain. On the paths that do reach the chain they must stay: see the `finally`.
  let claimed: string[] = [];
  let reachedChain = false;
  let outcomeUnknown = false;
  // Inputs that were promises rather than outputs the provider had confirmed. If the chain refuses
  // this transaction, they are the first thing to doubt.
  let promisedInputs: string[] = [];

  try {
    // A real bech32 decode rather than a prefix test: `addr1…` and `addr_test1…` are alike enough
    // to be pasted for one another, and a typo has a checksum precisely so that it is a rejection
    // instead of a payment.
    const destination = decodeCardanoAddress(toAddress);
    if (!destination) {
      throw new CardanoTransferRefusal(
        'CARDANO_INVALID_DESTINATION',
        `'${toAddress}' is not a readable Cardano address`
      );
    }
    if (destination.network !== network) {
      throw new CardanoTransferRefusal(
        'CARDANO_WRONG_NETWORK_DESTINATION',
        `destination belongs to Cardano ${destination.network}, this deployment operates on ${network}`
      );
    }

    account = cardanoSignerService.getAccount(fromPhoneNumber, network, chainId);
    if (account.address === toAddress) {
      throw new CardanoTransferRefusal(
        'CARDANO_SELF_TRANSFER',
        'sender and destination are the same address'
      );
    }

    // Two reads of the same address, because "what the sender can spend" is not a question the
    // provider answers on its own. The confirmed set is the rule for money that arrived from
    // outside: a deposit is not credited until a rollback can no longer take it back. But that rule
    // also hides the change of the transfer this user made a moment ago, which is not a deposit and
    // cannot roll back independently of the transaction that produced it -- so a wallet would go
    // unusable for a few blocks after every transfer.
    //
    // What is added back is exactly that: outputs of transactions this deployment submitted. What
    // is taken away is anything already claimed, which is what a spend that the provider has not
    // indexed yet looks like from here.
    const [parameters, tip, confirmed, everything] = await Promise.all([
      provider.protocolParameters(),
      provider.tip(),
      provider.confirmedUtxosFor(account.address, depositConfirmations),
      provider.utxosFor(account.address)
    ]);
    const confirmedOutpoints = new Set(confirmed.map(outpointOf));
    const unconfirmed = everything.filter((utxo) => !confirmedOutpoints.has(outpointOf(utxo)));
    const ownTransactions = await ownTransactionsAmong(unconfirmed);

    // Change of transactions submitted so recently that the provider reports nothing at all about
    // them. Merged in rather than waited for: a wallet that just spent everything it had holds its
    // whole balance in an output no query can see yet, and telling its owner they have no funds is
    // false. Anything the provider does report wins, so an output appears once.
    const pending = await spendablePendingChange(provider, account.address, everything);

    // A union rather than a filter over one of the sets: each is spendable on its own terms, and
    // making one conditional on another would tie this to one provider's idea of consistency
    // between two calls.
    const utxos = await unclaimedUtxos([
      ...confirmed,
      ...unconfirmed.filter((utxo) => ownTransactions.has(utxo.txHash)),
      ...pending
    ]);

    if (input.asset) {
      // Checked before the ADA balance so the message names the thing the user actually asked to
      // move. Being short of the token and being short of ADA are different problems with
      // different remedies.
      const heldTokens = assetBalance(utxos, input.asset);
      if (heldTokens < input.asset.quantity) {
        throw new CardanoTransferRefusal(
          'CARDANO_INSUFFICIENT_TOKEN_BALANCE',
          `insufficient balance: ${heldTokens} held at ${account.address}, ` +
            `${input.asset.quantity} requested`
        );
      }
    } else {
      const available: bigint = selectableBalance(utxos);
      if (available < amountLovelace) {
        // The address is part of the message on purpose: funding it is the only remedy, and burying
        // it in a log turns a self-serve fix into a support ticket.
        throw new CardanoTransferRefusal(
          'CARDANO_INSUFFICIENT_FUNDS',
          `insufficient ADA: ${available} lovelace confirmed at ${account.address}, ` +
            `${amountLovelace} requested (plus network fee). Fund that address to continue`
        );
      }
    }

    // Sponsoring, when it is on: a second wallet contributes an input that covers the fee, and gets
    // its own change output back. Cardano needs no paymaster contract for this -- a transaction may
    // spend inputs from several addresses and only asks for a signature from each owner.
    const feeConfig = getCardanoFeeConfig();
    const sponsorAccount = feeConfig.sponsorNetworkFee
      ? cardanoSignerService.getSponsorAccount(feeConfig.sponsorWalletId, network, chainId)
      : null;
    // Read without waiting for confirmations, unlike the sender's deposits. Everything the sponsor
    // holds it produced itself -- it is funded once and then spends and re-receives its own change
    // -- so the confirmation rule, which exists to keep somebody else's deposit from being credited
    // before a rollback could take it away, has nothing to protect here. Requiring it made the
    // sponsor unusable for a minute or two after every transfer.
    //
    // Spending an unconfirmed output is how Cardano chains transactions, and the failure mode is
    // benign: if the parent never reaches the chain, the child spends an input that does not exist
    // and is rejected outright. Nothing is lost and nothing is double-spent.
    const sponsorUtxos: readonly CardanoUtxo[] = sponsorAccount
      ? await unclaimedUtxos(await sponsorHoldings(provider, sponsorAccount.address))
      : [];

    if (sponsorAccount && spendableBalance(sponsorUtxos) === 0n) {
      // Refused rather than silently falling back to charging the user: a deployment that promised
      // to cover the fee and then takes it from the sender is worse than one that never promised.
      // The address stays in the log: naming it here would hand every user the operational wallet
      // and announce that it is empty.
      Logger.error(
        'cardanoTransfer',
        logKey,
        `CARDANO_SPONSOR_WALLET_EMPTY: ${sponsorAccount.address} holds no spendable ADA`
      );
      throw new CardanoTransferRefusal('CARDANO_SPONSOR_WALLET_EMPTY', SPONSOR_UNAVAILABLE);
    }

    // ChatterPay's fee, priced in whatever is moving and taken out of the amount. It needs a
    // sponsor: the fee rides in the sponsor's change output, and without one there is no output to
    // ride in — a deployment that is not sponsoring is not charging either.
    const chatterPayFee =
      sponsorAccount && chargesTransferFee(feeConfig)
        ? await chatterPayFeeUnits(feeConfig.transferFeeUsd, input.tokenSymbol, input.tokenDecimals)
        : 0n;

    const built = buildCardanoTransfer({
      utxos,
      destinationAddress: destination.payload,
      changeAddress: account.addressBytes,
      amount: amountLovelace,
      asset: input.asset,
      chatterPayFee,
      sponsor: sponsorAccount
        ? { utxos: sponsorUtxos, changeAddress: sponsorAccount.addressBytes }
        : undefined,
      ttlSlot: tip.slot + ttlSlots,
      parameters,
      witnessCount: sponsorAccount ? 2 : 1
    });

    // The invariant reconciliation depends on, asserted where refusing is still free: what came in
    // equals what went out. A transaction that does not balance is one the chain rejects, and
    // finding that out from the provider costs a signature.
    const consumed = built.inputs.reduce(
      (sum: bigint, utxo: CardanoUtxo) => sum + utxo.lovelace,
      0n
    );
    // Stated against what actually left, not against what was requested: on a token transfer the
    // ADA leaving is the minimum attached to the token output, which the builder decides.
    // What came in equals what went out. With a sponsor there is a second change output, and the
    // builder does not report it separately, so it is whatever the other three did not claim — a
    // residue that must exist and must not be negative. Asserted here, where refusing is still
    // free: a transaction that does not balance is one the chain rejects, and finding that out from
    // the provider costs a signature.
    // ChatterPay's fee is not subtracted here: on an ADA transfer it is already inside the sponsor's
    // change, and on a token transfer it is not lovelace at all.
    const sponsorChange = consumed - built.sentLovelace - built.fee - built.change;
    const balances = sponsorAccount ? sponsorChange >= 0n : sponsorChange === 0n;
    if (!balances) {
      throw new CardanoTransferRefusal(
        'CARDANO_TRANSACTION_DOES_NOT_BALANCE',
        `inputs ${consumed} != sent ${built.sentLovelace} + fee ${built.fee} + ` +
          `change ${built.change} (+ sponsor change ${sponsorChange})`
      );
    }

    Logger.log(
      'cardanoTransfer',
      logKey,
      `Built ${built.transactionId}: ${built.inputs.length} input(s), fee ${built.fee}, ` +
        `change ${built.change}, ttl ${built.ttlSlot}`
    );

    // Claimed now, because now is when the inputs are known: coin selection needs the amount and the
    // fee to decide, and both come out of the build. From here on those outputs belong to this
    // transaction -- the provider will keep offering them until it indexes the spend, and the claim
    // is what stops the next transfer from building around the very same ones.
    //
    // A claim that loses means another transfer got there first. Nothing has been signed, so this
    // costs nothing to refuse, and the retry will select around the outputs now taken.
    const promised = new Set([...pending, ...sponsorUtxos].map(outpointOf));
    promisedInputs = built.inputs.map(outpointOf).filter((outpoint) => promised.has(outpoint));

    const claim = await claimUtxos(built.inputs, logKey);
    if (!claim) {
      Logger.warn(
        'cardanoTransfer',
        logKey,
        `CARDANO_UTXO_BUSY: another transfer claimed one of ${built.inputs.length} input(s)`
      );
      throw new CardanoTransferRefusal('CARDANO_UTXO_BUSY', TRANSFER_BUSY);
    }
    claimed = claim;

    // Past this line the transaction exists as an authorised object. Everything above could refuse
    // for free; nothing below can.
    const signature = cardanoSignerService.sign(
      fromPhoneNumber,
      network,
      chainId,
      built.transactionId
    );
    const witnesses = [{ publicKey: account.publicKey, signature }];
    if (sponsorAccount) {
      witnesses.push({
        publicKey: sponsorAccount.publicKey,
        signature: cardanoSignerService.signAsSponsor(
          feeConfig.sponsorWalletId,
          network,
          chainId,
          built.transactionId
        )
      });
    }
    const signed = encodeSignedTransaction(built.bodyBytes, witnesses);

    const transactionHash = await submitResolvingTimeout(
      provider,
      signed,
      built.transactionId,
      logKey
    );

    reachedChain = true;
    // Recorded so the change this transaction is about to create can be spent by the next transfer
    // without waiting for confirmations. Without it a wallet that just paid cannot pay again for
    // several blocks, which is the same outage the claim above exists to prevent, arriving from the
    // other side. Two records, because the change goes through two stages of invisibility: first
    // the provider knows nothing of it (the pending output covers that), then it reports it with no
    // confirmations (the transaction id covers that).
    await recordOwnTransaction(transactionHash, logKey);
    if (built.changeIndex !== undefined && built.change > 0n) {
      await recordPendingChange(
        {
          txHash: transactionHash,
          outputIndex: built.changeIndex,
          lovelace: built.change,
          holdsOtherAssets: built.changeAssets.length > 0,
          assets: [...built.changeAssets]
        },
        account.address,
        logKey
      );
    }
    // The sponsor needs this more than anyone: it is one wallet behind every transfer, so its change
    // is unindexed exactly when the next transfer comes looking for it. Without this it funds one
    // transfer and then reports itself empty while holding the entire balance.
    if (sponsorAccount && built.sponsorChangeIndex !== undefined && sponsorChange > 0n) {
      await recordPendingChange(
        {
          txHash: transactionHash,
          outputIndex: built.sponsorChangeIndex,
          lovelace: sponsorChange,
          holdsOtherAssets: false
        },
        sponsorAccount.address,
        logKey
      );
    }

    Logger.info(
      'cardanoTransfer',
      logKey,
      `Submitted ${transactionHash}, network fee ${built.fee} lovelace` +
        (built.chatterPayFee > 0n
          ? `, ChatterPay fee ${built.chatterPayFee} ${input.tokenSymbol} base units`
          : '')
    );

    return {
      success: true,
      transactionHash,
      feeLovelace: built.fee,
      sentLovelace: built.sentLovelace,
      chatterPayFee: built.chatterPayFee,
      explorerUrl: `${explorerUrl}${transactionHash}`,
      errorCode: '',
      error: ''
    };
  } catch (error) {
    // An undetermined submit is the one outcome where the claims must stand: the transaction may be
    // in a mempool this process can no longer ask about, and handing its inputs to the next transfer
    // would build a second transaction around outputs the first one is still about to spend.
    if (error instanceof CardanoProviderError && error.undetermined) outcomeUnknown = true;
    // The chain refused it outright. When the transaction was built on an output that had only been
    // promised, the promise is the likeliest thing that was wrong -- the output may have been spent
    // by something that never passed through the claim store, or its transaction never landed.
    // Forgetting it keeps the next transfer from building on the same bad input over and over.
    if (error instanceof CardanoProviderError && error.failure === 'rejected_by_chain') {
      await forgetPendingChange(promisedInputs);
    }
    if (error instanceof CardanoTransferRefusal) {
      // Refused before signing: an expected outcome of a user-supplied input, not an incident.
      Logger.info('cardanoTransfer', logKey, `${error.code}: ${error.message}`);
      return failure(error.code, error.message);
    }
    if (error instanceof CardanoProviderError) {
      // The provider's own text names the host it could not reach and quotes its response body,
      // and this message is what the user is shown. The code classifies it for the log; the
      // sentence is the one a person can act on.
      logCardanoProviderError('cardanoTransfer', error);
      return failure(`CARDANO_PROVIDER_${error.failure.toUpperCase()}`, PROVIDER_UNREACHABLE);
    }
    const message = error instanceof Error ? error.message : String(error);
    // Errors raised by the builder are refusals too, they simply arrive as plain Errors: the codes
    // are already machine-readable, so the prefix is what separates them from anything unexpected.
    // A recognised code keeps its message, which was written to be read; anything else is a bug
    // report, and a bug report is not an answer to give somebody waiting on a transfer.
    const code = /^CARDANO_[A-Z_]+/.exec(message)?.[0] ?? '';
    Logger.error('cardanoTransfer', logKey, `${code || 'CARDANO_UNEXPECTED_ERROR'}: ${message}`);
    // A message that is nothing but its own code is a classification, not a sentence.
    return code && message.trim() !== code
      ? failure(code, message)
      : failure(code || 'CARDANO_UNEXPECTED_ERROR', TRANSFER_FAILED);
  } finally {
    // Released only when the transaction provably did not happen. The instinct is to release on
    // success too -- the chain consumed those outputs, so what is left to reserve? -- but that is
    // exactly the window this exists for: the provider goes on offering them until it indexes the
    // spend, and the next transfer would select the same ones and be rejected for spending inputs
    // that are already gone. On success the claim expires on its own, by which time the provider
    // has caught up and stopped offering them anyway.
    if (!reachedChain && !outcomeUnknown) await releaseUtxos(claimed);
  }
}
