import { createPrivateKey, createPublicKey, verify as nodeVerify } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import { CDS1 } from '../../../src/config/constants';
import { decodeCardanoAddress } from '../../../src/services/cardano/cardanoAddressService';
import { cardanoSignerService } from '../../../src/services/cardano/cardanoSignerService';
import { secService } from '../../../src/services/secService';

// Fixed inputs, so the suite is a property of the code and not of whatever the machine running it
// happens to have configured.
vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  return {
    ...actual,
    $SC: 'x',
    $B: 'y',
    CDC1: '743a643a',
    CDC2: '743a633a',
    CDC3: '7430',
    CDC4: '743a6b3a',
    CDC5: '743a733a',
    CDC6: '743a73733a'
  };
});

const CHAIN_ID = 900000000001;
const PHONE = '5491100000001';

/** DER header of an SPKI Ed25519 public key, ahead of its 32 raw bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Rebuilds a verifiable key object from the raw public key the signer publishes. */
function verifierFor(publicKeyHex: string) {
  const raw = Buffer.from(publicKeyHex.replace(/^0x/, ''), 'hex');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  });
}

describe('cardanoSignerService - derivation', () => {
  it('is deterministic: the same user always gets the same address', () => {
    // Nothing is stored anywhere, so determinism is what makes the address recoverable at all. It
    // is also why a backfill needs no rollback: deriving again gives the same answer.
    const first = cardanoSignerService.getAccount(PHONE, 'testnet', CHAIN_ID);
    const second = cardanoSignerService.getAccount(PHONE, 'testnet', CHAIN_ID);
    expect(first.address).toBe(second.address);
    expect(first.publicKey).toBe(second.publicKey);
  });

  it('normalises the phone number, so formatting does not change the wallet', () => {
    const plain = cardanoSignerService.getAccount('5491100000001', 'testnet', CHAIN_ID);
    const prefixed = cardanoSignerService.getAccount('+5491100000001', 'testnet', CHAIN_ID);
    expect(prefixed.address).toBe(plain.address);
  });

  it('gives different users different addresses', () => {
    const a = cardanoSignerService.getAccount('5491100000001', 'testnet', CHAIN_ID);
    const b = cardanoSignerService.getAccount('5491100000002', 'testnet', CHAIN_ID);
    expect(a.address).not.toBe(b.address);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('derives different key material per network, not just a different encoding', () => {
    // Preprod and mainnet are separate identities. Sharing the key would mean a mainnet address
    // whose testnet twin has been exercised by every test run that ever touched a faucet.
    const testnet = cardanoSignerService.getAccount(PHONE, 'testnet', CHAIN_ID);
    const mainnet = cardanoSignerService.getAccount(PHONE, 'mainnet', 900764824073);
    expect(mainnet.publicKey).not.toBe(testnet.publicKey);
    expect(mainnet.address).not.toBe(testnet.address);
  });

  it('publishes two 32-byte Ed25519 public keys', () => {
    const { publicKey, stakePublicKey } = cardanoSignerService.getAccount(
      PHONE,
      'testnet',
      CHAIN_ID
    );
    expect(publicKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(stakePublicKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('derives the staking key independently of the payment key', () => {
    // Same secret, same phone, same network — two different HKDF `info` strings. If they collided,
    // the address would carry the same credential twice and the staking key would be the spending
    // key, which is the one thing a separate role must not be.
    const { publicKey, stakePublicKey } = cardanoSignerService.getAccount(
      PHONE,
      'testnet',
      CHAIN_ID
    );
    expect(stakePublicKey).not.toBe(publicKey);
  });

  it('derives an address it can read back itself, with both credentials in it', () => {
    const { address, addressBytes } = cardanoSignerService.getAccount(PHONE, 'testnet', CHAIN_ID);
    const decoded = decodeCardanoAddress(address);
    expect(decoded).not.toBeNull();
    expect(decoded?.network).toBe('testnet');
    // Type 0: base address. Issuing type 6 here would make staking a migration of every funded
    // wallet rather than a certificate.
    expect(decoded?.addressType).toBe(0);
    expect(decoded?.stakeCredentialHex).toMatch(/^[0-9a-f]{56}$/);
    expect(decoded?.credentialHex).not.toBe(decoded?.stakeCredentialHex);
    expect(Buffer.from(addressBytes)).toEqual(Buffer.from(decoded!.payload));
  });
});

describe('cardanoSignerService - domain separation from the EVM key', () => {
  // The only test here that needs the EVM derivation, and so the only one that needs CDS1-3
  // configured. Skipped rather than fed hardcoded values: those live in the deployment's
  // environment and do not belong in a repository, and the twelve tests above still cover the
  // Cardano derivation without them.
  it.skipIf(!CDS1)('never derives the Cardano key from the EVM private key', () => {
    // `secService.get_up()` returns the user's EVM private key. If it were the Ed25519 seed, then
    // leaking one key would leak the other, on a different chain, silently. The two must be
    // independent derivations from the master secret, and this is the assertion that says so.
    const evmPrivateKey = secService.get_up(PHONE, String(CHAIN_ID)).replace(/^0x/, '');
    const { publicKey } = cardanoSignerService.getAccount(PHONE, 'testnet', CHAIN_ID);
    const cardanoKeyMaterial = publicKey.replace(/^0x/, '');

    expect(cardanoKeyMaterial).not.toBe(evmPrivateKey);

    // Stronger: the EVM private key used *as* an Ed25519 seed must not reproduce the Cardano
    // public key either. That is the failure a naive implementation actually makes.
    const naiveSeedKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(evmPrivateKey, 'hex')
      ]),
      format: 'der',
      type: 'pkcs8'
    });
    const naive = (createPublicKey(naiveSeedKey).export({ format: 'der', type: 'spki' }) as Buffer)
      .subarray(12)
      .toString('hex');
    expect(cardanoKeyMaterial).not.toBe(naive);
  });
});

describe('cardanoSignerService - signing', () => {
  const transactionId = 'ab'.repeat(32);

  it('produces a signature that verifies against the published public key', () => {
    // The property that matters end to end: the key the address was derived from is the key that
    // authorises spending from it. If these ever disagree, the wallet holds funds nobody can move.
    const { publicKey } = cardanoSignerService.getAccount(PHONE, 'testnet', CHAIN_ID);
    const signature = cardanoSignerService.sign(PHONE, 'testnet', CHAIN_ID, transactionId);

    expect(signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(
      nodeVerify(
        null,
        Buffer.from(transactionId, 'hex'),
        verifierFor(publicKey),
        Buffer.from(signature.replace(/^0x/, ''), 'hex')
      )
    ).toBe(true);
  });

  it('does not verify against another user key', () => {
    const other = cardanoSignerService.getAccount('5491100000002', 'testnet', CHAIN_ID);
    const signature = cardanoSignerService.sign(PHONE, 'testnet', CHAIN_ID, transactionId);
    expect(
      nodeVerify(
        null,
        Buffer.from(transactionId, 'hex'),
        verifierFor(other.publicKey),
        Buffer.from(signature.replace(/^0x/, ''), 'hex')
      )
    ).toBe(false);
  });

  it('is deterministic, as Ed25519 is by construction', () => {
    const first = cardanoSignerService.sign(PHONE, 'testnet', CHAIN_ID, transactionId);
    const second = cardanoSignerService.sign(PHONE, 'testnet', CHAIN_ID, transactionId);
    expect(first).toBe(second);
  });

  it('accepts the transaction id with or without the 0x prefix', () => {
    expect(cardanoSignerService.sign(PHONE, 'testnet', CHAIN_ID, `0x${transactionId}`)).toBe(
      cardanoSignerService.sign(PHONE, 'testnet', CHAIN_ID, transactionId)
    );
  });

  it('refuses anything that is not a 32-byte transaction id', () => {
    for (const bad of ['', 'deadbeef', 'zz'.repeat(32), 'ab'.repeat(31)]) {
      expect(() => cardanoSignerService.sign(PHONE, 'testnet', CHAIN_ID, bad)).toThrow(
        'CARDANO_INVALID_TRANSACTION_ID'
      );
    }
  });
});
