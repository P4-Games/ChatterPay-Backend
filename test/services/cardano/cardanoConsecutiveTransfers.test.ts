import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import { executeCardanoTransfer } from '../../../src/services/cardano/cardanoTransferService';
import { FakeCardanoProvider } from '../../helpers/fakeCardanoProvider';
import { resetCardanoUtxoClaims } from '../../support/cardanoClaims';
import { resetCardanoEnv, setCardanoFeeEnv } from '../../support/cardanoEnv';

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../../support/cardanoEnv');
  return cardanoConstantsMock(actual);
});

/**
 * Transfers that follow one another faster than the chain settles.
 *
 * This is the failure the product actually hit, and it is invisible to a test that sends once. A
 * provider reads an indexed chain, so a transaction sitting in the mempool has spent nothing as far
 * as it is concerned: the inputs it consumes keep being offered, and the change it creates does not
 * exist yet. Coin selection is deterministic by design — the same list has to produce the same fee
 * — so the next transfer reaches for the very same output and the node rejects it with
 * `All inputs are spent`.
 *
 * Nothing in the sender's own wallet protects against this. The concurrency lock does not either:
 * it is released when the transfer submits, and the window that matters opens exactly there.
 *
 * What these tests pin down is that consecutive transfers select disjoint inputs, and that a wallet
 * can spend the change it just produced.
 */

const CHAIN_ID = 900000000001;
const SENDER_PHONE = '5491100000001';
const RECIPIENT_PHONE = '5491100000002';

const sender = cardanoSignerService.getAccount(SENDER_PHONE, 'testnet', CHAIN_ID);
const recipient = cardanoSignerService.getAccount(RECIPIENT_PHONE, 'testnet', CHAIN_ID);
const EXTERNAL_ADDRESS =
  'addr_test1qrgnz9z5drgvfs5nzgrem3rkqae4sjvy3efnlulyecuqn8n2vur65tmrn5a3e592f9tllzdvmz0yg7jhkmfzcz8x3ecqug792f';

let provider: FakeCardanoProvider;

function transfer(overrides: Partial<Parameters<typeof executeCardanoTransfer>[0]> = {}) {
  return executeCardanoTransfer({
    fromPhoneNumber: SENDER_PHONE,
    toAddress: recipient.address,
    amountLovelace: 2_000_000n,
    tokenSymbol: 'ADA',
    tokenDecimals: 6,
    provider,
    network: 'testnet',
    chainId: CHAIN_ID,
    ttlSlots: 900,
    depositConfirmations: 3,
    explorerUrl: 'https://preprod.cardanoscan.io/transaction/',
    logKey: '[test:cardano]',
    ...overrides
  });
}

/** Every outpoint a submitted transaction consumed, in submission order. */
function inputsOf(provider: FakeCardanoProvider): string[][] {
  return provider.spentInputs;
}

beforeEach(async () => {
  resetCardanoEnv();
  setCardanoFeeEnv({ sponsorFees: false, sponsorWalletId: '' });
  provider = new FakeCardanoProvider();
  await resetCardanoUtxoClaims();
});

describe('consecutive transfers - the provider has not caught up yet', () => {
  it('does not spend the same output twice when the first spend is still unindexed', async () => {
    // Two outputs, either of which could fund either transfer. The fake goes on reporting a spent
    // output as available until `settleAsUnconfirmedChange` is called, which is exactly what a real
    // provider does while the block carrying the spend is still unindexed.
    provider.fund(sender.address, 10_000_000n);
    provider.fund(sender.address, 10_000_000n);

    const first = await transfer();
    const second = await transfer();

    expect(first.success, first.error).toBe(true);
    expect(second.success, second.error).toBe(true);

    const [firstInputs, secondInputs] = inputsOf(provider);
    expect(firstInputs.length).toBeGreaterThan(0);
    // The point of the whole mechanism: disjoint inputs, even though the provider offered the same
    // list both times.
    expect(secondInputs.filter((input) => firstInputs.includes(input))).toEqual([]);
  });

  it('sends twice from a single output, spending change the provider cannot see yet', async () => {
    // The state a wallet converges to: one output holding everything, because each transfer folds
    // the remainder back into a single change output. The second transfer can only be funded by
    // change from a transaction that has been submitted and nothing more -- no block, no index
    // entry, nothing to query. This is the case the incident actually hit.
    provider.fund(sender.address, 10_000_000n);

    const first = await transfer();
    const second = await transfer();

    expect(first.success, first.error).toBe(true);
    expect(second.success, second.error).toBe(true);
    const [firstInputs, secondInputs] = inputsOf(provider);
    expect(secondInputs.filter((input) => firstInputs.includes(input))).toEqual([]);
    // It spent the first transfer's change, which is the only thing it could have spent.
    expect(secondInputs.some((input) => input.startsWith(first.transactionHash))).toBe(true);
  });

  it('refuses without submitting once the wallet really is empty', async () => {
    // Chaining unspent change must not turn into inventing funds. Enough for one transfer and not
    // for two, so the second has to say so -- before signing, and without asking the chain to
    // reject anything.
    provider.fund(sender.address, 5_000_000n);

    const first = await transfer();
    const second = await transfer();

    expect(first.success, first.error).toBe(true);
    expect(second.success).toBe(false);
    // Which of the short-of-funds codes it is depends on where the shortfall lands; what matters is
    // that it refused rather than built something the chain would throw away.
    expect(second.errorCode).toMatch(
      /CARDANO_(INSUFFICIENT_FUNDS|CHANGE_WOULD_BE_BURNED|UTXO_BUSY)/
    );
    // One submission, not two: the refusal happened before anything was signed.
    expect(provider.submissions).toHaveLength(1);
  });

  it('spends the change of the previous transfer, which has no confirmations yet', async () => {
    // A single large output. The first transfer consumes it and creates change; the second can only
    // succeed by spending that change, which is younger than `depositConfirmations`.
    provider.fund(sender.address, 40_000_000n);

    const first = await transfer();
    expect(first.success, first.error).toBe(true);

    // The chain accepted it and produced the change, still in the newest block.
    provider.settleAsUnconfirmedChange(sender.address, first.transactionHash, 36_000_000n);

    const second = await transfer();

    expect(second.success, second.error).toBe(true);
    // The change really is the input it used -- not some other output that made the assertion pass.
    const [, secondInputs] = inputsOf(provider);
    expect(secondInputs.some((input) => input.startsWith(first.transactionHash))).toBe(true);
  });

  it('keeps an external destination on the same footing as a phone number', async () => {
    // The destination has nothing to do with input selection, and the incident hit both. Worth
    // pinning: a regression here would show up on one path and not the other.
    provider.fund(sender.address, 10_000_000n);
    provider.fund(sender.address, 10_000_000n);

    const toPhone = await transfer();
    const toAddress = await transfer({ toAddress: EXTERNAL_ADDRESS });

    expect(toPhone.success, toPhone.error).toBe(true);
    expect(toAddress.success, toAddress.error).toBe(true);
    const [firstInputs, secondInputs] = inputsOf(provider);
    expect(secondInputs.filter((input) => firstInputs.includes(input))).toEqual([]);
  });
});

describe('consecutive transfers - promises that turned out to be false', () => {
  it('stops offering change once its transaction is in a block and the output is not there', async () => {
    // The change was promised, the transaction landed, and by the time the next transfer looks the
    // output is gone -- spent by something that never passed through the claim store. Offering it
    // again builds a transaction around an input that does not exist, which the chain rejects with
    // `BadInputsUTxO`. Once the transaction is in a block the provider is the authority, so a
    // promise it does not corroborate has to be dropped.
    provider.fund(sender.address, 10_000_000n);

    const first = await transfer();
    expect(first.success, first.error).toBe(true);

    // The transaction reached a block, and the address holds nothing: the change is gone.
    provider.confirm(first.transactionHash, 3);
    provider.forgetUtxosOf(sender.address);

    const second = await transfer();

    expect(second.success).toBe(false);
    // Refused for lack of funds, not submitted and rejected by the chain.
    expect(provider.submissions).toHaveLength(1);
  });

  it('keeps offering change while its transaction is only in the mempool', async () => {
    // The mirror image, and the reason the rule is about blocks rather than about the provider
    // having heard of the transaction: a mempool sighting proves nothing about what is indexed, and
    // discarding the promise there would put the wallet back to being unusable between transfers.
    provider.fund(sender.address, 10_000_000n);

    const first = await transfer();
    const second = await transfer();

    expect(first.success, first.error).toBe(true);
    expect(second.success, second.error).toBe(true);
  });
});

describe('consecutive transfers - with the fee sponsor on', () => {
  it('does not reuse the sponsor output either', async () => {
    setCardanoFeeEnv({ sponsorFees: true, sponsorWalletId: 'test-sponsor', transferFeeUsd: 0 });
    const sponsor = cardanoSignerService.getSponsorAccount('test-sponsor', 'testnet', CHAIN_ID);

    provider.fund(sender.address, 10_000_000n);
    provider.fund(sender.address, 10_000_000n);
    provider.fund(sponsor.address, 10_000_000n);
    provider.fund(sponsor.address, 10_000_000n);

    const first = await transfer();
    const second = await transfer();

    expect(first.success, first.error).toBe(true);
    expect(second.success, second.error).toBe(true);
    const [firstInputs, secondInputs] = inputsOf(provider);
    // Sponsor and sender inputs travel in the same transaction, so one assertion covers both: no
    // outpoint may appear twice.
    expect(secondInputs.filter((input) => firstInputs.includes(input))).toEqual([]);
  });
});
