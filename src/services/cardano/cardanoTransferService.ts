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
 *
 * @see CARDANO_INTEGRATION_PLAN.md §6.2
 */

import { Logger } from '../../helpers/loggerHelper';
import type {
  CardanoAccount,
  CardanoAssetAmount,
  CardanoNetwork,
  CardanoUtxo
} from '../../types/cardanoType';
import { decodeCardanoAddress } from './cardanoAddressService';
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
  spendableBalance
} from './cardanoTxService';

/** Everything a transfer needs to be attempted. */
export interface CardanoTransferInput {
  /** Phone number of the sender: the identity the signing key derives from. */
  fromPhoneNumber: string;
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
  /** Machine-readable failure code, empty on success. */
  errorCode: string;
  /** Human-readable failure detail, empty on success. */
  error: string;
}

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
    throw new CardanoProviderError(
      error.failure,
      `${error.message} (transaction ${expectedId} is not on chain; it is safe to retry)`,
      false
    );
  }
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

    const [parameters, tip, utxos] = await Promise.all([
      provider.protocolParameters(),
      provider.tip(),
      provider.confirmedUtxosFor(account.address, depositConfirmations)
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
      const available: bigint = spendableBalance(utxos);
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

    const built = buildCardanoTransfer({
      utxos,
      destinationAddress: destination.payload,
      changeAddress: account.addressBytes,
      amount: amountLovelace,
      asset: input.asset,
      ttlSlot: tip.slot + ttlSlots,
      parameters,
      // One key signs: the wallet's own. A platform fee or subsidy input would add a second
      // witness, and it is not built here.
      witnessCount: 1
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
    if (consumed !== built.sentLovelace + built.fee + built.change) {
      throw new CardanoTransferRefusal(
        'CARDANO_TRANSACTION_DOES_NOT_BALANCE',
        `inputs ${consumed} != sent ${built.sentLovelace} + fee ${built.fee} + change ${built.change}`
      );
    }

    Logger.log(
      'cardanoTransfer',
      logKey,
      `Built ${built.transactionId}: ${built.inputs.length} input(s), fee ${built.fee}, ` +
        `change ${built.change}, ttl ${built.ttlSlot}`
    );

    // Past this line the transaction exists as an authorised object. Everything above could refuse
    // for free; nothing below can.
    const signature = cardanoSignerService.sign(
      fromPhoneNumber,
      network,
      chainId,
      built.transactionId
    );
    const signed = encodeSignedTransaction(built.bodyBytes, [
      { publicKey: account.publicKey, signature }
    ]);

    const transactionHash = await submitResolvingTimeout(
      provider,
      signed,
      built.transactionId,
      logKey
    );

    Logger.info(
      'cardanoTransfer',
      logKey,
      `Submitted ${transactionHash}, fee ${built.fee} lovelace`
    );

    return {
      success: true,
      transactionHash,
      feeLovelace: built.fee,
      sentLovelace: built.sentLovelace,
      explorerUrl: `${explorerUrl}${transactionHash}`,
      errorCode: '',
      error: ''
    };
  } catch (error) {
    if (error instanceof CardanoTransferRefusal) {
      // Refused before signing: an expected outcome of a user-supplied input, not an incident.
      Logger.info('cardanoTransfer', logKey, `${error.code}: ${error.message}`);
      return failure(error.code, error.message);
    }
    if (error instanceof CardanoProviderError) {
      logCardanoProviderError('cardanoTransfer', error);
      return failure(`CARDANO_PROVIDER_${error.failure.toUpperCase()}`, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    // Errors raised by the builder are refusals too, they simply arrive as plain Errors: the codes
    // are already machine-readable, so the prefix is what separates them from anything unexpected.
    const code = /^CARDANO_[A-Z_]+/.exec(message)?.[0] ?? 'CARDANO_UNEXPECTED_ERROR';
    Logger.error('cardanoTransfer', logKey, `${code}: ${message}`);
    return failure(code, message);
  }
}
