/**
 * What a staking transaction costs, and what is left over.
 *
 * Two questions, and they are not independent. The fee on Cardano is a linear function of the
 * **serialized size of the signed transaction**, so the witnesses are part of what is charged for:
 * a fee computed over the body alone is short by roughly a hundred bytes per signature. And the
 * change is what remains after the fee, the deposits and the outputs — so a fee that is wrong by
 * one witness makes the change wrong by the same amount, and the ledger rejects a transaction whose
 * arithmetic does not close.
 *
 * **Witnesses are counted by distinct key, not by input.** A wallet that spends four of its own
 * UTxOs signs once. What is easy to miss is the other direction: a staking transaction needs a
 * witness for the **stake** key as well as the payment key, because a certificate addresses the
 * stake credential and a withdrawal empties the account that credential owns. They live in the same
 * wallet and are different keys, so they are two witnesses. Under Plan B the sponsor's payment key
 * is a third, since the sponsor supplies the inputs that pay the fee.
 *
 * Nothing here signs, selects coins or submits. It is arithmetic over bytes that already exist.
 */

import type { CardanoProtocolParameters } from '../../types/cardanoType';
import type { CardanoStakingCertificate, CardanoWithdrawal } from './cardanoCertificateService';
import { encodeSignedTransaction } from './cardanoTxService';

/** Size of a raw Ed25519 public key. */
const PUBLIC_KEY_BYTES = 32;

/** Size of a raw Ed25519 signature. */
const SIGNATURE_BYTES = 64;

/** Who has to sign a staking transaction. */
export interface CardanoStakingSigners {
  /**
   * Payment key hash behind the sponsor's inputs.
   *
   * Under Plan B the sponsor pays the network fee, so its inputs are in the transaction and its key
   * signs. `null` when the transaction spends nothing of the sponsor's.
   */
  sponsorPaymentKeyHash?: string | null;
  /** Payment key hash behind the user's inputs. `null` when the user contributes none. */
  userPaymentKeyHash?: string | null;
  /**
   * The user's **stake** key hash.
   *
   * Needed only when something in the transaction addresses the stake credential, which this module
   * works out from the certificates and withdrawals rather than taking on trust.
   */
  userStakeKeyHash?: string | null;
}

/** What a staking transaction moves, beside its inputs and outputs. */
export interface CardanoStakingAmounts {
  /** Lovelace held by the inputs being spent. */
  inputsLovelace: bigint;
  /** Lovelace claimed from reward accounts. */
  withdrawalsLovelace: bigint;
  /**
   * Deposits refunded by deregistration certificates.
   *
   * What was actually paid at registration, read back from the confirmed transaction. Cardano
   * refunds what was deposited, not what the protocol parameter says today.
   */
  refundsLovelace: bigint;
  /** Lovelace in the explicit outputs, change excluded. */
  outputsLovelace: bigint;
  /** Deposits taken by registration certificates. */
  depositsLovelace: bigint;
  feeLovelace: bigint;
}

/**
 * The distinct keys that must sign.
 *
 * Returned sorted and deduplicated, because that is what the count has to be: two entries naming
 * the same key are one witness, and paying for two would leave the transaction over-funded in a way
 * the ledger does not refund.
 *
 * The stake key is included only when the transaction actually addresses the stake credential.
 * Adding it unconditionally would overcharge every plain transfer by a witness; leaving it out when
 * a certificate is present produces a transaction the ledger rejects as unwitnessed, after the fee
 * has already been computed too low to rebuild it.
 *
 * @param signers - The candidate keys.
 * @param certificates - Certificates the transaction carries, if any.
 * @param withdrawals - Withdrawals the transaction carries, if any.
 * @returns The distinct key hashes, lowercase and sorted.
 */
export function requiredWitnessKeys(
  signers: CardanoStakingSigners,
  certificates: readonly CardanoStakingCertificate[] = [],
  withdrawals: readonly CardanoWithdrawal[] = []
): string[] {
  const addressesStakeCredential = certificates.length > 0 || withdrawals.length > 0;

  const keys = [
    signers.sponsorPaymentKeyHash,
    signers.userPaymentKeyHash,
    addressesStakeCredential ? signers.userStakeKeyHash : null
  ]
    .filter((key): key is string => typeof key === 'string' && key.length > 0)
    .map((key) => key.toLowerCase());

  return [...new Set(keys)].sort();
}

/**
 * How many distinct signatures the transaction carries.
 *
 * @param signers - The candidate keys.
 * @param certificates - Certificates the transaction carries, if any.
 * @param withdrawals - Withdrawals the transaction carries, if any.
 * @returns The witness count.
 * @throws Error `CARDANO_NO_SIGNER` when nothing would sign. An unsigned transaction is not one
 *   anybody can submit, and a fee computed for zero witnesses is a fee for a transaction that
 *   cannot exist.
 */
export function requiredWitnessCount(
  signers: CardanoStakingSigners,
  certificates: readonly CardanoStakingCertificate[] = [],
  withdrawals: readonly CardanoWithdrawal[] = []
): number {
  const keys = requiredWitnessKeys(signers, certificates, withdrawals);
  if (keys.length === 0) throw new Error('CARDANO_NO_SIGNER');
  return keys.length;
}

/**
 * The size the signed transaction will have, measured rather than estimated.
 *
 * The body is serialized already; the witnesses are not, so they are stood in for by placeholders
 * of the exact shape a real one has — a 32-byte key and a 64-byte signature. Ed25519 signatures are
 * fixed width, so the placeholder is the same size as the real thing and the measurement is exact,
 * not an approximation that has to be padded.
 *
 * @param bodyBytes - The serialized transaction body.
 * @param witnessCount - Distinct signatures, from {@link requiredWitnessCount}.
 * @returns The size of the signed transaction, in bytes.
 */
export function signedTransactionSize(bodyBytes: Uint8Array, witnessCount: number): number {
  const placeholders = Array.from({ length: Math.max(1, witnessCount) }, () => ({
    publicKey: '00'.repeat(PUBLIC_KEY_BYTES),
    signature: '00'.repeat(SIGNATURE_BYTES)
  }));

  return encodeSignedTransaction(bodyBytes, placeholders).length / 2;
}

export interface CardanoStakingFee {
  sizeBytes: number;
  witnessCount: number;
  feeLovelace: bigint;
}

/**
 * The fee a staking transaction pays.
 *
 * @param bodyBytes - The serialized transaction body.
 * @param witnessCount - Distinct signatures.
 * @param parameters - Protocol parameters in force.
 * @returns The size, the witness count it assumed, and the fee.
 * @throws Error `CARDANO_TX_TOO_LARGE` when the signed transaction exceeds `maxTxSize`. Submitting
 *   it would be rejected by every node, and the fee it implies is meaningless.
 */
export function stakingTransactionFee(
  bodyBytes: Uint8Array,
  witnessCount: number,
  parameters: CardanoProtocolParameters
): CardanoStakingFee {
  const sizeBytes = signedTransactionSize(bodyBytes, witnessCount);
  if (sizeBytes > parameters.maxTxSize) throw new Error('CARDANO_TX_TOO_LARGE');

  return {
    sizeBytes,
    witnessCount,
    feeLovelace: BigInt(parameters.minFeeA) * BigInt(sizeBytes) + BigInt(parameters.minFeeB)
  };
}

/**
 * What is left for change, by the ledger's own accounting.
 *
 * Conway's rule is that what a transaction consumes equals what it produces:
 *
 *     inputs + withdrawals + refunds  =  outputs + fee + deposits
 *
 * Both sides carry staking terms, and the two that are easiest to get backwards are the deposit and
 * the refund. A registration **consumes** ada into the deposit, so it is on the produced side; a
 * deregistration **returns** it, so it is on the consumed side. Putting either on the wrong side
 * balances arithmetically against itself and leaves the transaction rejected by the ledger with no
 * clue as to which term was wrong.
 *
 * @param amounts - Everything the transaction moves.
 * @returns The change, in lovelace.
 * @throws Error `CARDANO_UNBALANCED_TRANSACTION` when the transaction produces more than it
 *   consumes. Returning a negative change would push the failure into the output encoder, which
 *   would encode it as an enormous unsigned integer.
 */
export function stakingChangeLovelace(amounts: CardanoStakingAmounts): bigint {
  const consumed = amounts.inputsLovelace + amounts.withdrawalsLovelace + amounts.refundsLovelace;
  const produced = amounts.outputsLovelace + amounts.feeLovelace + amounts.depositsLovelace;

  if (produced > consumed) throw new Error('CARDANO_UNBALANCED_TRANSACTION');
  return consumed - produced;
}

/**
 * Whether the two sides of the ledger equation agree, change included.
 *
 * The check a builder runs before handing a transaction to a signer: it is cheap here and expensive
 * on chain, where an imbalance is a rejection after the fee budget has already been reserved.
 *
 * @param amounts - Everything the transaction moves.
 * @param changeLovelace - The change output that was actually built, zero when there is none.
 * @returns Whether consumed equals produced.
 */
export function stakingTransactionBalances(
  amounts: CardanoStakingAmounts,
  changeLovelace: bigint
): boolean {
  const consumed = amounts.inputsLovelace + amounts.withdrawalsLovelace + amounts.refundsLovelace;
  const produced =
    amounts.outputsLovelace + amounts.feeLovelace + amounts.depositsLovelace + changeLovelace;

  return consumed === produced;
}
