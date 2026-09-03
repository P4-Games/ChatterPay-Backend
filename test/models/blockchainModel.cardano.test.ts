import { describe, expect, it } from 'vitest';

import Blockchain, { type IBlockchain } from '../../src/models/blockchainModel';

/**
 * The EVM-only fields a Cardano network has no answer for.
 *
 * These are asserted by name rather than by "the document validates" alone, because the failure
 * this suite guards against is the opposite of a crash: a schema loose enough to accept a Cardano
 * row would also accept an EVM row missing its RPC endpoint, and that one fails later, in
 * production, on a transfer.
 */
const EVM_ONLY_PATHS = [
  'manteca_name',
  'rpc',
  'rpcBundler',
  'marketplaceOpenseaUrl',
  'supportsEIP1559',
  'externalDeposits',
  'gas.useFixedValues',
  'gas.operations.transfer',
  'gas.operations.swap',
  'balances.paymasterMinBalance',
  'balances.backendSignerMinBalance',
  'limits.swap',
  'limits.mint_nft',
  'limits.mint_nft_copy'
];

/** A Cardano network document, exactly as the seed script writes it. */
function cardanoDoc(): Partial<IBlockchain> {
  return {
    name: 'Cardano Preprod',
    family: 'cardano',
    chainId: 900000000001,
    environment: 'TEST',
    explorer: 'https://preprod.cardanoscan.io/transaction/',
    cardano: {
      network: 'testnet',
      providerUrl: 'https://preprod.koios.rest/api/v1',
      ttlSlots: 900,
      depositConfirmations: 3
    },
    // `D` is the daily operation count per user level — the same shape the EVM rows use. Per-amount
    // limits live on the token, not here.
    limits: {
      transfer: { L1: { D: 14 }, L2: { D: 100 } }
    }
  } as Partial<IBlockchain>;
}

describe('blockchainModel - Cardano networks', () => {
  it('validates a Cardano document that carries no EVM fields at all', async () => {
    const doc = new Blockchain(cardanoDoc());
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('still requires the transfer limits, which are product policy and not an EVM detail', async () => {
    const withoutLimits = cardanoDoc();
    withoutLimits.limits = undefined as unknown as IBlockchain['limits'];
    const doc = new Blockchain(withoutLimits);
    await expect(doc.validate()).rejects.toThrow(/limits\.transfer/);
  });

  it('requires name, chainId, explorer and environment on every family', async () => {
    for (const field of ['name', 'chainId', 'explorer', 'environment'] as const) {
      const partial = cardanoDoc();
      delete partial[field];
      const doc = new Blockchain(partial);
      await expect(doc.validate(), field).rejects.toThrow(new RegExp(field));
    }
  });

  it('keeps every EVM-only field required for EVM networks', async () => {
    // The regression that matters: relaxing the schema for Cardano must not relax it for Scroll.
    const doc = new Blockchain({
      name: 'Scroll Sepolia',
      chainId: 534351,
      environment: 'TEST',
      explorer: 'https://sepolia.scrollscan.com/tx/'
    });

    const error = await doc.validate().then(
      () => null,
      (caught: Error) => caught
    );

    expect(error, 'an EVM network missing its RPC must not validate').not.toBeNull();
    const message = String(error);
    for (const path of EVM_ONLY_PATHS) {
      expect(message, `${path} should still be required for EVM`).toContain(path);
    }
  });

  it('defaults family to evm, so documents written before Cardano keep their meaning', () => {
    const doc = new Blockchain({ name: 'Scroll Sepolia', chainId: 534351 });
    expect(doc.family).toBe('evm');
  });

  it('rejects a family outside the known set', async () => {
    const doc = new Blockchain({ ...cardanoDoc(), family: 'solana' as never });
    await expect(doc.validate()).rejects.toThrow(/family/);
  });
});
