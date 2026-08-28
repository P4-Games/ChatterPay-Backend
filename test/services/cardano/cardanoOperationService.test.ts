import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import Token from '../../../src/models/tokenModel';
import { type IUser, UserModel } from '../../../src/models/userModel';
import {
  executeCardanoOperation,
  resolveCardanoDestination,
  resolveCardanoToken
} from '../../../src/services/cardano/cardanoOperationService';
import {
  deriveCardanoAccount,
  ensureCardanoWalletForUser,
  getOrCreateCardanoWallet
} from '../../../src/services/cardano/cardanoWalletService';
import { FakeCardanoProvider } from '../../helpers/fakeCardanoProvider';
import { resetCardanoUtxoClaims } from '../../support/cardanoClaims';
import { enableCardanoPreprod, setCardanoEnv } from '../../support/cardanoEnv';

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

const SENDER_PHONE = '5491100000001';
const RECIPIENT_PHONE = '5491100000002';
const NEW_PHONE = '5491100000003';

const EXTERNAL_ADDRESS =
  'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';
const MAINNET_ADDRESS = 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8';

let provider: FakeCardanoProvider;

/** Creates a ChatterPay user with only an EVM wallet, as every existing user has. */
async function createEvmOnlyUser(phone: string): Promise<IUser> {
  return UserModel.create({
    phone_number: phone,
    wallets: [
      {
        wallet_proxy: '0x1111111111111111111111111111111111111111',
        wallet_eoa: '0x2222222222222222222222222222222222222222',
        chain_id: 534351,
        status: 'active'
      }
    ]
  });
}

/** A native stablecoin, shaped like the real thing: 28-byte policy, hex name, six decimals. */
const USDM = {
  policyId: 'a1'.repeat(28),
  assetName: Buffer.from('USDM').toString('hex')
};
const USDM_UNIT = `${USDM.policyId}${USDM.assetName}`;

/**
 * Seeds the token catalogue.
 *
 * The operation resolves a ticker into a policy id through this collection rather than through a
 * table in the code, so without it there is nothing to send.
 */
async function seedTokens(): Promise<void> {
  const limits = {
    transfer: { L1: { min: 1, max: 1000 }, L2: { min: 1, max: 1000 } },
    swap: { L1: { min: 0, max: 0 }, L2: { min: 0, max: 0 } }
  };
  await Token.create([
    {
      name: 'Cardano ADA',
      symbol: 'ADA',
      display_symbol: 'ADA',
      chain_id: CARDANO_PREPROD_CHAIN_ID,
      decimals: 6,
      display_decimals: 2,
      address: 'cardano:testnet:lovelace',
      type: 'variable',
      ramp_enabled: false,
      operations_limits: limits
    },
    {
      name: 'USDM',
      symbol: 'USDM',
      display_symbol: 'USDM',
      chain_id: CARDANO_PREPROD_CHAIN_ID,
      decimals: 6,
      display_decimals: 2,
      address: USDM_UNIT,
      type: 'stable',
      ramp_enabled: false,
      operations_limits: limits
    }
  ]);
}

beforeEach(async () => {
  enableCardanoPreprod();
  provider = new FakeCardanoProvider();
  await seedTokens();
  await resetCardanoUtxoClaims();
});

describe('cardanoWalletService - provisioning', () => {
  it('adds a Cardano wallet to a user who only had an EVM one', async () => {
    const user = await createEvmOnlyUser(SENDER_PHONE);
    expect(user.wallets).toHaveLength(1);

    const wallet = await ensureCardanoWalletForUser(user);

    expect(wallet.wasCreated).toBe(true);
    expect(wallet.address).toMatch(/^addr_test1/);

    const stored = await UserModel.findOne({ phone_number: SENDER_PHONE });
    expect(stored?.wallets).toHaveLength(2);

    const cardanoWallet = stored?.wallets.find((w) => w.chain_id === CARDANO_PREPROD_CHAIN_ID);
    expect(cardanoWallet?.address_type).toBe('cardano_base');
    expect(cardanoWallet?.cardano_public_key).toMatch(/^0x[0-9a-f]{64}$/);
    // Persisted even though it signs nothing: it is half of what the address hashes, and whatever
    // registers this stake credential later needs the key and not just the hash.
    expect(cardanoWallet?.cardano_stake_public_key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(cardanoWallet?.cardano_stake_public_key).not.toBe(cardanoWallet?.cardano_public_key);
    // Both fields carry the address so every existing reader keeps working unchanged.
    expect(cardanoWallet?.wallet_proxy).toBe(wallet.address);
    expect(cardanoWallet?.wallet_eoa).toBe(wallet.address);
    // The EVM wallet is untouched.
    expect(stored?.wallets.find((w) => w.chain_id === 534351)?.wallet_proxy).toBe(
      '0x1111111111111111111111111111111111111111'
    );
  });

  it('is idempotent: calling it again neither duplicates nor changes the address', async () => {
    const user = await createEvmOnlyUser(SENDER_PHONE);
    const first = await ensureCardanoWalletForUser(user);
    const second = await ensureCardanoWalletForUser(user);

    expect(second.wasCreated).toBe(false);
    expect(second.address).toBe(first.address);
    const stored = await UserModel.findOne({ phone_number: SENDER_PHONE });
    expect(stored?.wallets.filter((w) => w.chain_id === CARDANO_PREPROD_CHAIN_ID)).toHaveLength(1);
  });

  it('refuses to continue when the stored address is not the one these keys derive', async () => {
    // The seed changed, or the row came from another deployment. Either way the funds sit at an
    // address these keys cannot sign for, and building a transaction would produce one nobody can
    // authorise.
    const user = await createEvmOnlyUser(SENDER_PHONE);
    await ensureCardanoWalletForUser(user);
    const wallet = user.wallets.find((w) => w.chain_id === CARDANO_PREPROD_CHAIN_ID)!;
    wallet.wallet_proxy = 'addr_test1vz74kulhkqmrdrrg6u57we4pzckf07wj5e906zdpeddpz2ct8f930';
    await user.save();

    await expect(ensureCardanoWalletForUser(user)).rejects.toThrow('CARDANO_ADDRESS_MISMATCH');
  });

  it('creates the user when the phone number belongs to nobody yet', async () => {
    expect(await UserModel.findOne({ phone_number: NEW_PHONE })).toBeNull();

    const { user, wallet } = await getOrCreateCardanoWallet(NEW_PHONE);

    expect(wallet.wasCreated).toBe(true);
    expect(user.phone_number).toBe(NEW_PHONE);
    // The address is a function of the phone number, so it matches what a pure derivation gives.
    expect(wallet.address).toBe(deriveCardanoAccount(NEW_PHONE).address);
  });
});

describe('resolveCardanoToken - what a figure is shown with', () => {
  // Two different numbers that a single `decimals` would collapse into one. The ledger counts ADA
  // in millionths and the product quotes it to two, so a notification formatted off `decimals`
  // would read `10.000000 ADA`. The EVM path has always read the catalogue for this; the Cardano
  // path could not, because the resolved token did not carry it.
  it('carries the catalogue display_decimals alongside the ledger decimals, for ADA', async () => {
    const resolved = await resolveCardanoToken('ADA', CARDANO_PREPROD_CHAIN_ID);

    expect(resolved.isAda).toBe(true);
    expect(resolved.decimals).toBe(6);
    expect(resolved.displayDecimals).toBe(2);
  });

  it('carries it for a native asset too', async () => {
    const resolved = await resolveCardanoToken('USDM', CARDANO_PREPROD_CHAIN_ID);

    expect(resolved.isAda).toBe(false);
    expect(resolved.decimals).toBe(6);
    expect(resolved.displayDecimals).toBe(2);
  });

  it('reads it off the row the ticker resolves to, however the ticker was cased', async () => {
    const resolved = await resolveCardanoToken('usdm', CARDANO_PREPROD_CHAIN_ID);

    expect(resolved.symbol).toBe('USDM');
    expect(resolved.displayDecimals).toBe(2);
  });
});

describe('resolveCardanoDestination', () => {
  it('takes a bech32 address as given', async () => {
    const resolved = await resolveCardanoDestination(EXTERNAL_ADDRESS);
    expect(resolved.resolvedFrom).toBe('address');
    expect(resolved.address).toBe(EXTERNAL_ADDRESS);
    expect(resolved.user).toBeNull();
  });

  it('resolves a phone number into a wallet, creating the recipient', async () => {
    const resolved = await resolveCardanoDestination(RECIPIENT_PHONE);
    expect(resolved.resolvedFrom).toBe('phone');
    expect(resolved.address).toBe(deriveCardanoAccount(RECIPIENT_PHONE).address);
    expect(resolved.user?.phone_number).toBe(RECIPIENT_PHONE);
  });

  it('refuses a mistyped address instead of treating it as a phone number', async () => {
    const typo = `${EXTERNAL_ADDRESS.slice(0, -1)}x`;
    await expect(resolveCardanoDestination(typo)).rejects.toThrow('CARDANO_INVALID_DESTINATION');
  });

  it('refuses a value that is neither an address nor a phone number', async () => {
    for (const bad of ['hello', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', '123']) {
      await expect(resolveCardanoDestination(bad), bad).rejects.toThrow(
        'CARDANO_INVALID_DESTINATION'
      );
    }
  });
});

describe('executeCardanoOperation - phone to phone', () => {
  it('moves ADA between two ChatterPay users', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    const senderAddress = deriveCardanoAccount(SENDER_PHONE).address;
    provider.fund(senderAddress, 15_000_000n);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '2.5',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(true);
    expect(result.fromAddress).toBe(senderAddress);
    expect(result.toAddress).toBe(deriveCardanoAccount(RECIPIENT_PHONE).address);
    expect(result.toUser?.phone_number).toBe(RECIPIENT_PHONE);
    expect(result.transactionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(result.networkFeeAda)).toBeGreaterThan(0);
    expect(result.explorerUrl).toContain('preprod.cardanoscan.io/transaction/');

    // Both wallets ended up persisted, the recipient's created on the way through.
    const recipient = await UserModel.findOne({ phone_number: RECIPIENT_PHONE });
    expect(recipient?.wallets.some((w) => w.chain_id === CARDANO_PREPROD_CHAIN_ID)).toBe(true);
  });

  it('sends to a phone number that has never used ChatterPay', async () => {
    // The point of an address that is a pure function of a key: the recipient needs to do nothing
    // first.
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    provider.fund(deriveCardanoAccount(SENDER_PHONE).address, 15_000_000n);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: NEW_PHONE,
      amount: '2',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(true);
    expect(await UserModel.findOne({ phone_number: NEW_PHONE })).not.toBeNull();
  });

  it('sends to an external bech32 address without creating any user', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    provider.fund(deriveCardanoAccount(SENDER_PHONE).address, 15_000_000n);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: EXTERNAL_ADDRESS,
      amount: '2',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(true);
    expect(result.toUser).toBeNull();
    expect(await UserModel.countDocuments()).toBe(1);
  });
});

describe('executeCardanoOperation - native stablecoins', () => {
  it('sends USDM phone to phone, with the ADA the protocol forces along', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    provider.fundWithAssets(deriveCardanoAccount(SENDER_PHONE).address, 10_000_000n, [
      { ...USDM, quantity: 100_000_000n }
    ]);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '30',
      token: 'USDM',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(true);
    expect(result.tokenSymbol).toBe('USDM');
    // The ADA that travels with the token is real money leaving the sender, and it is reported so
    // that a balance dropping by more than the fee has an explanation.
    expect(Number(result.sentAda)).toBeGreaterThan(1);
    expect(Number(result.sentAda)).toBeLessThan(2);
    expect(Number(result.networkFeeAda)).toBeGreaterThan(0);
  });

  it('scales the amount by the token decimals, not by ADA six', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    provider.fundWithAssets(deriveCardanoAccount(SENDER_PHONE).address, 10_000_000n, [
      { ...USDM, quantity: 100_000_000n }
    ]);

    // 30.5 USDM at six decimals is 30_500_000 base units. Sending it leaves 69_500_000 behind.
    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '30.5',
      token: 'USDM',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(true);
  });

  it('refuses when the wallet holds the token but not enough of it', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    provider.fundWithAssets(deriveCardanoAccount(SENDER_PHONE).address, 10_000_000n, [
      { ...USDM, quantity: 10_000_000n }
    ]);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '30',
      token: 'USDM',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_INSUFFICIENT_TOKEN_BALANCE');
    expect(provider.submissions).toHaveLength(0);
  });

  it('refuses a stablecoin wallet with no ADA, which is a state a user can really be in', async () => {
    // Holding 100 USDM and no ADA means holding something you cannot move. There is no amount of
    // USDM that buys the ADA to move it.
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    provider.fundWithAssets(deriveCardanoAccount(SENDER_PHONE).address, 1_100_000n, [
      { ...USDM, quantity: 100_000_000n }
    ]);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '30',
      token: 'USDM',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_INSUFFICIENT_FUNDS');
    expect(provider.submissions).toHaveLength(0);
  });

  it('refuses a ticker nobody registered on this network', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '30',
      token: 'USDT',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_UNKNOWN_TOKEN');
  });

  it('refuses a token row whose address is not a usable asset unit', async () => {
    // A misconfigured policy id must fail loudly. The alternative is a perfectly valid transfer of
    // an asset that is not the one anybody meant.
    await Token.create({
      name: 'Broken',
      symbol: 'BRKN',
      display_symbol: 'BRKN',
      chain_id: CARDANO_PREPROD_CHAIN_ID,
      decimals: 6,
      display_decimals: 2,
      address: 'not-a-policy-id',
      type: 'stable',
      ramp_enabled: false,
      operations_limits: {
        transfer: { L1: { min: 1, max: 10 }, L2: { min: 1, max: 10 } },
        swap: { L1: { min: 0, max: 0 }, L2: { min: 0, max: 0 } }
      }
    });
    const sender = await createEvmOnlyUser(SENDER_PHONE);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '1',
      token: 'BRKN',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_TOKEN_MISCONFIGURED');
  });
});

describe('executeCardanoOperation - refusals', () => {
  it('reports insufficient funds naming the address to fund', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    provider.fund(deriveCardanoAccount(SENDER_PHONE).address, 1_000_000n);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '5',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_INSUFFICIENT_FUNDS');
    expect(result.error).toContain(deriveCardanoAccount(SENDER_PHONE).address);
  });

  it('refuses a mainnet destination on a testnet deployment', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);
    provider.fund(deriveCardanoAccount(SENDER_PHONE).address, 15_000_000n);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: MAINNET_ADDRESS,
      amount: '2',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_WRONG_NETWORK_DESTINATION');
    expect(provider.submissions).toHaveLength(0);
  });

  it('refuses an amount with more precision than ADA has', async () => {
    const sender = await createEvmOnlyUser(SENDER_PHONE);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '1.0000001',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_AMOUNT_TOO_PRECISE');
    // Refused before the recipient was provisioned: a destination that cannot be paid should not
    // leave a half-created user behind.
    expect(await UserModel.findOne({ phone_number: RECIPIENT_PHONE })).toBeNull();
  });

  it('reports the family as unavailable rather than half-working when it is off', async () => {
    setCardanoEnv({ enabled: false });
    const sender = await createEvmOnlyUser(SENDER_PHONE);

    const result = await executeCardanoOperation({
      fromUser: sender,
      to: RECIPIENT_PHONE,
      amount: '2',
      logKey: '[test]',
      provider
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CARDANO_DISABLED');
    expect(provider.submissions).toHaveLength(0);
  });
});
