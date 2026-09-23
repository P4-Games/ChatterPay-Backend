/**
 * Selects the inputs of a staking transaction and places its outputs, for both wallets at once.
 *
 * A staking transaction has two payers and they pay for different things. Under Plan B the **user**
 * funds the registration deposit — which is the user's own asset, refundable in full when the
 * credential is deregistered, not a cost and not ada that earns rewards by itself — and the
 * **sponsor** funds the network fee. Commercial transfer fees are untouched: where a staking
 * operation also sends value, ChatterPay charges what it already charges, out of the amount, riding
 * home in the sponsor's change exactly as `buildCardanoTransfer` does it.
 *
 * That split is why this is a separate builder rather than a flag on the transfer one. Two payers
 * means two independent selections and two change outputs, and the single sentence the ledger
 * actually checks spans both of them:
 *
 *     inputs + withdrawals + refunds = outputs + fee + deposits + change
 *
 * **The fee loop.** The fee is a function of the serialized size, the size depends on how many
 * inputs were selected, and how many inputs were selected depends on the fee. So it iterates until
 * the fee stops rising, the way the transfer builder does, rather than padding an estimate. The
 * witness count feeding that size is the number of **distinct** keys that sign — the stake key is
 * one of them whenever a certificate or a withdrawal is present, and it is a different key from the
 * payment key of the same wallet.
 *
 * **Native assets are respected, not avoided.** Tokens in the selected inputs come home in that
 * wallet's own change output, which then has to clear its own min-ADA. For a full exit that is the
 * reason the wallet cannot be emptied to zero: the output carrying the tokens has to keep enough
 * ada to exist.
 *
 * Nothing here signs, submits, reads a database or touches the network. It is arithmetic over a
 * plan, which is what makes the borders — dust change, a sponsor with no funds, a fee that moves
 * the selection — testable without arranging them on a chain first.
 */

import type {
  CardanoAssetAmount,
  CardanoProtocolParameters,
  CardanoUtxo
} from '../../types/cardanoType';
import type {
  CardanoCredential,
  CardanoDRepTarget,
  CardanoStakingCertificate,
  CardanoWithdrawal
} from './cardanoCertificateService';
import {
  requiredWitnessCount,
  requiredWitnessKeys,
  stakingChangeLovelace,
  stakingTransactionBalances,
  stakingTransactionFee
} from './cardanoStakingFeeService';
import {
  encodeOutput,
  encodeTransactionBody,
  mergeAssets,
  minimumAdaFor,
  selectableUtxos,
  spendableUtxos,
  totalAssets,
  transactionIdOf
} from './cardanoTxService';

/**
 * Ceiling on the build loop. Each pass can only raise the fee, and a higher fee pulls in at most a
 * further input or two, so convergence takes two or three passes; more than this is a defect.
 */
const MAX_FEE_PASSES = 8;

/** What a staking transaction is for. */
export type CardanoStakingOperationShape =
  | 'register_and_delegate'
  | 'withdraw_rewards'
  | 'deregister'
  | 'exit_and_send_max'
  | 'redelegate_pool'
  | 'delegate_vote';

export interface CardanoStakingPlan {
  shape: CardanoStakingOperationShape;
  parameters: CardanoProtocolParameters;
  ttlSlot: number;

  /** The user's base address, where their change returns. */
  userAddressBytes: Uint8Array;
  userUtxos: readonly CardanoUtxo[];
  userPaymentKeyHash: string;
  userStakeKeyHash: string;
  /** The stake credential the certificates address. */
  stakeCredential: CardanoCredential;
  /** The reward account a withdrawal empties, bech32. */
  rewardAddress: string;

  /** The sponsor's address, where its change returns. */
  sponsorAddressBytes: Uint8Array;
  sponsorUtxos: readonly CardanoUtxo[];
  sponsorPaymentKeyHash: string;

  /**
   * Deposit for a registration, from the protocol parameters in force.
   *
   * Required for `register_and_delegate` and meaningless elsewhere.
   */
  depositLovelace?: bigint;
  /**
   * Deposit **actually paid** when the credential was registered, for a deregistration.
   *
   * Read back from the confirmed registration, never from today's protocol parameter: Cardano
   * refunds what was deposited, and a certificate built from a parameter that has changed since
   * fails to balance.
   */
  refundLovelace?: bigint;
  /** Rewards to claim, from the on-chain snapshot. Zero means no withdrawal at all. */
  withdrawalLovelace?: bigint;
  poolId?: string;
  drep?: CardanoDRepTarget;

  /** Where an exit sends what is left. */
  recipientAddressBytes?: Uint8Array;
  /**
   * ChatterPay's commercial fee on the amount an exit sends.
   *
   * Supplied by the caller from the existing fee service rather than computed here, so that the
   * commercial schedule has exactly one implementation and this builder stays pure.
   */
  commercialFeeLovelace?: bigint;
}

export interface BuiltCardanoStakingTransaction {
  bodyBytes: Uint8Array;
  bodyHex: string;
  transactionId: string;
  certificates: readonly CardanoStakingCertificate[];
  withdrawals: readonly CardanoWithdrawal[];

  selectedUserUtxos: readonly CardanoUtxo[];
  selectedSponsorUtxos: readonly CardanoUtxo[];
  /** The distinct keys that must sign, sorted. */
  witnessKeys: readonly string[];

  networkFeeLovelace: bigint;
  commercialFeeLovelace: bigint;
  depositLovelace: bigint;
  refundLovelace: bigint;
  withdrawalLovelace: bigint;

  userChangeLovelace: bigint;
  userChangeAssets: readonly CardanoAssetAmount[];
  sponsorChangeLovelace: bigint;
  sponsorChangeAssets: readonly CardanoAssetAmount[];
  /** What the destination receives on an exit, commercial fee already deducted. */
  recipientLovelace: bigint;
  sizeBytes: number;
}

/**
 * The certificates one operation needs.
 *
 * @param plan - The plan being built.
 * @returns The certificates, in the order the ledger should apply them.
 * @throws Error `CARDANO_STAKING_POOL_REQUIRED` / `CARDANO_STAKING_DREP_REQUIRED` /
 *   `CARDANO_STAKING_DEPOSIT_REQUIRED` / `CARDANO_STAKING_REFUND_REQUIRED` when the plan does not
 *   carry what its shape needs. Refused here rather than defaulted: a registration built with a
 *   guessed deposit is rejected on chain after the fee budget has already been reserved.
 */
export function certificatesFor(plan: CardanoStakingPlan): CardanoStakingCertificate[] {
  const stake = plan.stakeCredential;

  switch (plan.shape) {
    case 'register_and_delegate': {
      if (plan.depositLovelace === undefined) throw new Error('CARDANO_STAKING_DEPOSIT_REQUIRED');
      if (plan.poolId === undefined) throw new Error('CARDANO_STAKING_POOL_REQUIRED');
      if (plan.drep === undefined) throw new Error('CARDANO_STAKING_DREP_REQUIRED');
      // One certificate, not three. A registration that lands without its delegation leaves a paid
      // deposit earning nothing, and a delegation whose registration never landed is invalid.
      return [
        {
          kind: 'register_and_delegate_pool_and_vote',
          stake,
          poolId: plan.poolId,
          drep: plan.drep,
          depositLovelace: plan.depositLovelace
        }
      ];
    }
    case 'redelegate_pool': {
      if (plan.poolId === undefined) throw new Error('CARDANO_STAKING_POOL_REQUIRED');
      return [{ kind: 'delegate_pool', stake, poolId: plan.poolId }];
    }
    case 'delegate_vote': {
      if (plan.drep === undefined) throw new Error('CARDANO_STAKING_DREP_REQUIRED');
      // Vote delegation is independent of the pool: this certificate names no pool, so an existing
      // stake delegation is untouched by it.
      return [{ kind: 'delegate_vote', stake, drep: plan.drep }];
    }
    case 'deregister':
    case 'exit_and_send_max': {
      if (plan.refundLovelace === undefined) throw new Error('CARDANO_STAKING_REFUND_REQUIRED');
      return [{ kind: 'deregister', stake, refundLovelace: plan.refundLovelace }];
    }
    case 'withdraw_rewards':
      return [];
  }
}

/**
 * The withdrawals one operation needs.
 *
 * A deregistration **must** empty the reward account in the same transaction when it holds
 * anything: the ledger refuses to deregister a credential with a non-zero reward balance, and the
 * refusal arrives as a rejected transaction rather than as a partial one.
 *
 * @param plan - The plan being built.
 * @returns The withdrawals, empty when there is nothing to claim.
 */
export function withdrawalsFor(plan: CardanoStakingPlan): CardanoWithdrawal[] {
  const amount = plan.withdrawalLovelace ?? 0n;
  if (amount <= 0n) return [];
  if (plan.shape === 'register_and_delegate' || plan.shape === 'delegate_vote') return [];
  return [{ rewardAddress: plan.rewardAddress, lovelace: amount }];
}

/** The assets a set of inputs carries home. */
function assetsOf(utxos: readonly CardanoUtxo[]): CardanoAssetAmount[] {
  return totalAssets(utxos);
}

/** Lovelace held by a set of inputs. */
function lovelaceOf(utxos: readonly CardanoUtxo[]): bigint {
  return utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
}

/**
 * Takes outputs off the front of an ordered list until they cover a target.
 *
 * @param available - Outputs in the order they should be reached for.
 * @param target - Lovelace to cover. Zero or less selects nothing.
 * @param error - Which shortfall to report.
 * @returns The selected outputs.
 * @throws Error with `error` when everything available is not enough.
 */
function takeUntil(
  available: readonly CardanoUtxo[],
  target: bigint,
  error: string
): CardanoUtxo[] {
  if (target <= 0n) return [];

  const selected: CardanoUtxo[] = [];
  let total = 0n;
  for (const utxo of available) {
    selected.push(utxo);
    total += utxo.lovelace;
    if (total >= target) return selected;
  }
  throw new Error(`${error}: have ${total} lovelace, need ${target}`);
}

/**
 * The floor a change output has to clear, or zero when there is no change output.
 *
 * @param addressBytes - Address the change returns to.
 * @param assets - Assets it carries.
 * @param needed - Whether the output exists at all.
 * @param coinsPerUtxoByte - Protocol parameter.
 * @returns The minimum lovelace the output must hold.
 */
function changeFloor(
  addressBytes: Uint8Array,
  assets: readonly CardanoAssetAmount[],
  needed: boolean,
  coinsPerUtxoByte: bigint
): bigint {
  if (!needed && assets.length === 0) return 0n;
  return minimumAdaFor(addressBytes, assets, coinsPerUtxoByte);
}

/**
 * Builds a staking transaction: selects both wallets' inputs, settles the fee, places the change.
 *
 * @param plan - What to build.
 * @returns The body, its id, and every figure reconciliation needs.
 * @throws Error `CARDANO_INSUFFICIENT_USER_FUNDS` when the user cannot cover the deposit and the
 *   min-ADA of their own change, `CARDANO_INSUFFICIENT_SPONSOR_FUNDS` when the sponsor cannot cover
 *   the network fee, `CARDANO_STAKING_FEE_DID_NOT_CONVERGE` when the loop fails to settle, and
 *   `CARDANO_STAKING_UNBALANCED` when the two sides of the ledger equation disagree — a defect,
 *   caught here rather than by a node.
 */
export function buildCardanoStakingTransaction(
  plan: CardanoStakingPlan
): BuiltCardanoStakingTransaction {
  const { parameters, ttlSlot } = plan;
  const certificates = certificatesFor(plan);
  const withdrawals = withdrawalsFor(plan);

  const witnessKeys = requiredWitnessKeys(
    {
      sponsorPaymentKeyHash: plan.sponsorPaymentKeyHash,
      userPaymentKeyHash: plan.userPaymentKeyHash,
      userStakeKeyHash: plan.userStakeKeyHash
    },
    certificates,
    withdrawals
  );
  const witnessCount = requiredWitnessCount(
    {
      sponsorPaymentKeyHash: plan.sponsorPaymentKeyHash,
      userPaymentKeyHash: plan.userPaymentKeyHash,
      userStakeKeyHash: plan.userStakeKeyHash
    },
    certificates,
    withdrawals
  );

  const depositLovelace =
    plan.shape === 'register_and_delegate' ? (plan.depositLovelace ?? 0n) : 0n;
  const refundLovelace =
    plan.shape === 'deregister' || plan.shape === 'exit_and_send_max'
      ? (plan.refundLovelace ?? 0n)
      : 0n;
  const withdrawalLovelace = withdrawals.reduce((sum, entry) => sum + entry.lovelace, 0n);
  const commercialFeeLovelace =
    plan.shape === 'exit_and_send_max' ? (plan.commercialFeeLovelace ?? 0n) : 0n;

  const isExit = plan.shape === 'exit_and_send_max';
  // An exit spends everything the wallet holds; every other shape reaches for as little as it can.
  const userAvailable = selectableUtxos(plan.userUtxos);
  const sponsorAvailable = spendableUtxos(plan.sponsorUtxos);

  let networkFee = BigInt(parameters.minFeeB);
  let built: BuiltCardanoStakingTransaction | null = null;

  for (let pass = 0; pass < MAX_FEE_PASSES; pass += 1) {
    // --- the user's side -------------------------------------------------------------------
    // Everything for an exit; otherwise only what the deposit and the user's own change floor
    // require, less whatever the withdrawal and the refund already bring in.
    let selectedUser: CardanoUtxo[];
    let userChangeAssets: CardanoAssetAmount[];
    let userChange: bigint;

    if (isExit) {
      selectedUser = [...userAvailable];
      userChangeAssets = assetsOf(selectedUser);
      // The wallet cannot go to zero while it holds tokens: the output carrying them has to keep
      // enough ada to exist. That residue is the documented reason a full exit is not literally
      // everything.
      userChange = changeFloor(
        plan.userAddressBytes,
        userChangeAssets,
        false,
        parameters.coinsPerUtxoByte
      );
    } else {
      const incoming = withdrawalLovelace + refundLovelace;
      let floor = 0n;
      selectedUser = [];
      for (let inner = 0; inner < MAX_FEE_PASSES; inner += 1) {
        const target = depositLovelace + floor - incoming;
        selectedUser = takeUntil(userAvailable, target, 'CARDANO_INSUFFICIENT_USER_FUNDS');
        const assets = assetsOf(selectedUser);
        const next = changeFloor(
          plan.userAddressBytes,
          assets,
          lovelaceOf(selectedUser) + incoming > depositLovelace,
          parameters.coinsPerUtxoByte
        );
        if (next <= floor) break;
        floor = next;
      }
      userChangeAssets = assetsOf(selectedUser);
      userChange = lovelaceOf(selectedUser) + incoming - depositLovelace;
      if (userChange < 0n) throw new Error('CARDANO_INSUFFICIENT_USER_FUNDS');
    }

    const userGross = isExit
      ? lovelaceOf(selectedUser) + withdrawalLovelace + refundLovelace - userChange
      : 0n;
    const recipientLovelace = isExit ? userGross - commercialFeeLovelace : 0n;

    if (isExit && recipientLovelace <= 0n) {
      throw new Error('CARDANO_STAKING_EXIT_BELOW_COMMERCIAL_FEE');
    }

    // --- the sponsor's side ----------------------------------------------------------------
    // The sponsor covers the network fee and carries ChatterPay's commercial fee home in its own
    // change, which is where the existing transfer builder already puts it.
    let sponsorFloor = 0n;
    let selectedSponsor: CardanoUtxo[] = [];
    for (let inner = 0; inner < MAX_FEE_PASSES; inner += 1) {
      const target = networkFee + sponsorFloor - commercialFeeLovelace;
      selectedSponsor = takeUntil(sponsorAvailable, target, 'CARDANO_INSUFFICIENT_SPONSOR_FUNDS');
      const assets = assetsOf(selectedSponsor);
      const next = changeFloor(
        plan.sponsorAddressBytes,
        assets,
        lovelaceOf(selectedSponsor) + commercialFeeLovelace > networkFee,
        parameters.coinsPerUtxoByte
      );
      if (next <= sponsorFloor) break;
      sponsorFloor = next;
    }

    const sponsorChangeAssets = assetsOf(selectedSponsor);
    const sponsorChange = lovelaceOf(selectedSponsor) + commercialFeeLovelace - networkFee;
    if (sponsorChange < 0n) throw new Error('CARDANO_INSUFFICIENT_SPONSOR_FUNDS');

    // --- outputs, in a fixed order so two identical plans build identical bytes --------------
    const outputs: Uint8Array[] = [];
    if (isExit && plan.recipientAddressBytes !== undefined) {
      outputs.push(encodeOutput(plan.recipientAddressBytes, recipientLovelace));
    }
    if (userChange > 0n) {
      outputs.push(encodeOutput(plan.userAddressBytes, userChange, userChangeAssets));
    }
    if (sponsorChange > 0n) {
      outputs.push(encodeOutput(plan.sponsorAddressBytes, sponsorChange, sponsorChangeAssets));
    }

    const inputs = [...selectedUser, ...selectedSponsor];
    const bodyBytes = encodeTransactionBody(inputs, outputs, networkFee, ttlSlot, {
      certificates,
      withdrawals
    });

    const fee = stakingTransactionFee(bodyBytes, witnessCount, parameters);
    if (fee.feeLovelace > networkFee) {
      networkFee = fee.feeLovelace;
      built = null;
      continue;
    }

    const outputsLovelace = recipientLovelace + userChange + sponsorChange;
    const amounts = {
      inputsLovelace: lovelaceOf(inputs),
      withdrawalsLovelace: withdrawalLovelace,
      refundsLovelace: refundLovelace,
      outputsLovelace,
      depositsLovelace: depositLovelace,
      feeLovelace: networkFee
    };
    // The check a builder runs before handing anything to a signer: cheap here, and on chain a
    // rejection that arrives after the fee budget has already been reserved.
    if (!stakingTransactionBalances({ ...amounts, outputsLovelace: 0n }, outputsLovelace)) {
      throw new Error('CARDANO_STAKING_UNBALANCED');
    }

    built = {
      bodyBytes,
      bodyHex: Buffer.from(bodyBytes).toString('hex'),
      transactionId: transactionIdOf(bodyBytes),
      certificates,
      withdrawals,
      selectedUserUtxos: selectedUser,
      selectedSponsorUtxos: selectedSponsor,
      witnessKeys,
      networkFeeLovelace: networkFee,
      commercialFeeLovelace,
      depositLovelace,
      refundLovelace,
      withdrawalLovelace,
      userChangeLovelace: userChange,
      userChangeAssets,
      sponsorChangeLovelace: sponsorChange,
      sponsorChangeAssets: mergeAssets(sponsorChangeAssets),
      recipientLovelace,
      sizeBytes: fee.sizeBytes
    };
    break;
  }

  if (built === null) throw new Error('CARDANO_STAKING_FEE_DID_NOT_CONVERGE');
  return built;
}

/**
 * What the change of a staking transaction would be, without building one.
 *
 * For a pre-flight that has to say "this will not work" before anything is reserved.
 *
 * @param amounts - The figures the operation moves.
 * @returns The change in lovelace.
 */
export function stakingPreflightChange(amounts: {
  inputsLovelace: bigint;
  withdrawalsLovelace: bigint;
  refundsLovelace: bigint;
  outputsLovelace: bigint;
  depositsLovelace: bigint;
  feeLovelace: bigint;
}): bigint {
  return stakingChangeLovelace(amounts);
}
