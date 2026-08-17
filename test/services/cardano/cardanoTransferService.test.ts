import { beforeEach, describe, expect, it } from 'vitest';

import { CardanoProviderError } from '../../../src/services/cardano/cardanoProviderService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import { executeCardanoTransfer } from '../../../src/services/cardano/cardanoTransferService';
import { FakeCardanoProvider } from '../../helpers/fakeCardanoProvider';

const CHAIN_ID = 900000000001;
const SENDER_PHONE = '5491100000001';
const RECIPIENT_PHONE = '5491100000002';

const sender = cardanoSignerService.getAccount(SENDER_PHONE, 'testnet', CHAIN_ID);
const recipient = cardanoSignerService.getAccount(RECIPIENT_PHONE, 'testnet', CHAIN_ID);

/** A real mainnet address, for the network-mismatch case. */
const MAINNET_ADDRESS = 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8';

let provider: FakeCardanoProvider;

function transfer(overrides: Partial<Parameters<typeof executeCardanoTransfer>[0]> = {}) {
  return executeCardanoTransfer({
    fromPhoneNumber: SENDER_PHONE,
    toAddress: recipient.address,
    amountLovelace: 2_000_000n,
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

beforeEach(() => {
  provider = new FakeCardanoProvider();
});

describe('executeCardanoTransfer - the happy path', () => {
  it('sends ADA and reports the exact fee it paid', async () => {
    provider.fund(sender.address, 15_000_000n);

    const result = await transfer();

    expect(result.success).toBe(true);
    expect(result.transactionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.feeLovelace).toBeGreaterThan(0n);
    expect(result.explorerUrl).toBe(
      `https://preprod.cardanoscan.io/transaction/${result.transactionHash}`
    );
    expect(result.errorCode).toBe('');
    // The transaction the chain got is the one whose id was reported.
    expect(provider.submitted.has(result.transactionHash)).toBe(true);
  });

  it('sends to an external base address, which is what real wallets hand out', async () => {
    provider.fund(sender.address, 15_000_000n);
    const external =
      'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';

    const result = await transfer({ toAddress: external });

    expect(result.success).toBe(true);
  });

  it('spends only confirmed outputs', async () => {
    // Enough ADA in total, but most of it is too shallow to be firm. Crediting from an output that
    // a rollback could erase is how a ledger ends up counting funds that are not there.
    provider.fund(sender.address, 15_000_000n, { confirmations: 1 });
    provider.fund(sender.address, 1_000_000n, { confirmations: 10 });

    const result = await transfer({ amountLovelace: 5_000_000n });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_INSUFFICIENT_FUNDS');
  });

  it('ignores ADA locked in outputs that also hold native assets', async () => {
    provider.fundWithNativeAssets(sender.address, 100_000_000n);

    const result = await transfer();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_INSUFFICIENT_FUNDS');
  });
});

describe('executeCardanoTransfer - refusals happen before any signature', () => {
  it('refuses a mainnet address on a testnet deployment', async () => {
    provider.fund(sender.address, 15_000_000n);

    const result = await transfer({ toAddress: MAINNET_ADDRESS });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_WRONG_NETWORK_DESTINATION');
    // Nothing left: Cardano cannot cancel a submitted transaction, so the only clean failure is
    // one that never went out.
    expect(provider.submissions).toHaveLength(0);
  });

  it('refuses an address with a typo, on the checksum', async () => {
    provider.fund(sender.address, 15_000_000n);
    const typo = `${recipient.address.slice(0, -1)}${recipient.address.at(-1) === 'z' ? 'x' : 'z'}`;

    const result = await transfer({ toAddress: typo });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_INVALID_DESTINATION');
    expect(provider.submissions).toHaveLength(0);
  });

  it('refuses sending to oneself', async () => {
    provider.fund(sender.address, 15_000_000n);

    const result = await transfer({ toAddress: sender.address });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_SELF_TRANSFER');
    expect(provider.submissions).toHaveLength(0);
  });

  it('names the address to fund when the balance is short', async () => {
    provider.fund(sender.address, 1_000_000n);

    const result = await transfer({ amountLovelace: 5_000_000n });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_INSUFFICIENT_FUNDS');
    // Funding it is the only remedy; burying the address in a log turns a self-serve fix into a
    // support ticket.
    expect(result.error).toContain(sender.address);
    expect(provider.submissions).toHaveLength(0);
  });

  it('refuses an amount below the min-ADA an output may hold', async () => {
    provider.fund(sender.address, 15_000_000n);

    const result = await transfer({ amountLovelace: 80_000n });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_AMOUNT_BELOW_MINIMUM_UTXO');
    expect(provider.submissions).toHaveLength(0);
  });

  it('refuses when funds cover the amount but not the fee', async () => {
    provider.fund(sender.address, 2_000_000n);

    const result = await transfer({ amountLovelace: 2_000_000n });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_INSUFFICIENT_FUNDS');
    expect(provider.submissions).toHaveLength(0);
  });
});

describe('executeCardanoTransfer - provider failures', () => {
  it('reports a chain rejection as final', async () => {
    provider.fund(sender.address, 15_000_000n);
    provider.failNextSubmit('reject');

    const result = await transfer();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_PROVIDER_REJECTED_BY_CHAIN');
  });

  it('classifies a rate limit while reading', async () => {
    provider.fund(sender.address, 15_000_000n);
    provider.failNextRead(new CardanoProviderError('rate_limited', 'CARDANO_PROVIDER_429'));

    const result = await transfer();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_PROVIDER_RATE_LIMITED');
    expect(provider.submissions).toHaveLength(0);
  });
});

describe('executeCardanoTransfer - the undetermined submit', () => {
  it('treats a timed-out submit whose transaction did land as a success, without resubmitting', async () => {
    // The case that costs money twice if it is got wrong. Cardano has no replace-by-fee and no
    // nonce: sending again would be a second transaction spending the same inputs, and the
    // operation would end up reported against whichever one lost.
    provider.fund(sender.address, 15_000_000n);
    provider.failNextSubmit('timeout_landed');

    const result = await transfer();

    expect(result.success).toBe(true);
    expect(provider.submitted.has(result.transactionHash)).toBe(true);
    // Exactly one submission reached the provider. A retry here would be the double-spend.
    expect(provider.submissions).toHaveLength(1);
  });

  it('reports a timed-out submit whose transaction did not land as safe to retry', async () => {
    provider.fund(sender.address, 15_000_000n);
    provider.failNextSubmit('timeout_lost');

    const result = await transfer();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_PROVIDER_TIMEOUT');
    expect(result.error).toContain('safe to retry');
    expect(provider.submissions).toHaveLength(1);
  });
});

describe('executeCardanoTransfer - what reaches the chain', () => {
  it('submits a transaction signed by the key the sender address derives from', async () => {
    // If the address and the signing key ever disagree, the wallet holds funds nobody can move.
    provider.fund(sender.address, 15_000_000n);

    const result = await transfer();

    expect(result.success).toBe(true);
    const submitted = provider.submissions[0];
    // The witness carries the sender's public key, and the body carries the sender's address as
    // the change output.
    expect(submitted).toContain(sender.publicKey.replace(/^0x/, ''));
    expect(submitted).toContain(Buffer.from(sender.addressBytes).toString('hex'));
    expect(submitted).toContain(Buffer.from(recipient.addressBytes).toString('hex'));
  });
});
