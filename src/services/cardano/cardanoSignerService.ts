import { ed25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { $B, $S, CDC1, CDC2, CDC3, CDC4, CDC5, CDC6 } from '../../config/constants';
import { $hx } from '../../helpers/envHelper';
import { getPhoneNumberFormatted } from '../../helpers/formatHelper';
import type { CardanoAccount, CardanoNetwork } from '../../types/cardanoType';
import { baseAddress, decodeCardanoAddress } from './cardanoAddressService';

const SEED_BYTES = 32;

type KeyRole = 'payment' | 'stake';

function sponsorSeed(walletId: string, network: CardanoNetwork, chainId: number): Buffer {
  if (!$S) throw new Error('CARDANO_SEED_SALT_MISSING');
  const ikm = Buffer.from(`${$S}${$B}${walletId}`, 'utf8');
  const salt = Buffer.from(`${$hx(CDC1)}${network}`, 'utf8');
  const info = Buffer.from(`${$hx(CDC2)}${$hx(CDC5)}${$hx(CDC3)}:${chainId}`, 'utf8');
  return Buffer.from(hkdf(sha256, ikm, salt, info, SEED_BYTES));
}

function ed25519Seed(
  phoneNumber: string,
  network: CardanoNetwork,
  chainId: number,
  role: KeyRole = 'payment'
): Buffer {
  if (!$S) throw new Error('CARDANO_SEED_SALT_MISSING');
  const ikm = Buffer.from(`${$S}${$B}${getPhoneNumberFormatted(phoneNumber)}`, 'utf8');
  const salt = Buffer.from(`${$hx(CDC1)}${network}`, 'utf8');
  const label = role === 'stake' ? `${$hx(CDC4)}${$hx(CDC3)}` : $hx(CDC3);
  const info = Buffer.from(`${$hx(CDC2)}${label}:${chainId}`, 'utf8');
  return Buffer.from(hkdf(sha256, ikm, salt, info, SEED_BYTES));
}

function publicKeyOf(seed: Buffer): string {
  return `0x${Buffer.from(ed25519.getPublicKey(seed)).toString('hex')}`;
}

export const cardanoSignerService = {
  getPublicKey: (phoneNumber: string, network: CardanoNetwork, chainId: number): string =>
    publicKeyOf(ed25519Seed(phoneNumber, network, chainId)),

  getAccount: (phoneNumber: string, network: CardanoNetwork, chainId: number): CardanoAccount => {
    const publicKey = publicKeyOf(ed25519Seed(phoneNumber, network, chainId));
    const stakePublicKey = publicKeyOf(ed25519Seed(phoneNumber, network, chainId, 'stake'));
    const address = baseAddress(publicKey, stakePublicKey, network);
    const decoded = decodeCardanoAddress(address);
    if (!decoded) throw new Error('CARDANO_ADDRESS_DERIVATION_FAILED');
    return { address, addressBytes: decoded.payload, publicKey, stakePublicKey };
  },

  getSponsorAccount: (
    walletId: string,
    network: CardanoNetwork,
    chainId: number
  ): CardanoAccount => {
    const seed = sponsorSeed(walletId, network, chainId);
    const publicKey = publicKeyOf(seed);
    const stakePublicKey = publicKeyOf(
      Buffer.from(
        hkdf(
          sha256,
          seed,
          Buffer.from(`${$hx(CDC1)}${network}`, 'utf8'),
          Buffer.from(`${$hx(CDC2)}${$hx(CDC6)}${$hx(CDC3)}`, 'utf8'),
          SEED_BYTES
        )
      )
    );
    const address = baseAddress(publicKey, stakePublicKey, network);
    const decoded = decodeCardanoAddress(address);
    if (!decoded) throw new Error('CARDANO_ADDRESS_DERIVATION_FAILED');
    return { address, addressBytes: decoded.payload, publicKey, stakePublicKey };
  },

  signAsSponsor: (
    walletId: string,
    network: CardanoNetwork,
    chainId: number,
    transactionId: string
  ): string => {
    const hex = transactionId.startsWith('0x') ? transactionId.slice(2) : transactionId;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('CARDANO_INVALID_TRANSACTION_ID');
    const signature = ed25519.sign(
      Buffer.from(hex, 'hex'),
      sponsorSeed(walletId, network, chainId)
    );
    return `0x${Buffer.from(signature).toString('hex')}`;
  },

  sign: (
    phoneNumber: string,
    network: CardanoNetwork,
    chainId: number,
    transactionId: string
  ): string => {
    const hex = transactionId.startsWith('0x') ? transactionId.slice(2) : transactionId;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('CARDANO_INVALID_TRANSACTION_ID');
    const seed = ed25519Seed(phoneNumber, network, chainId);
    const signature = ed25519.sign(Buffer.from(hex, 'hex'), seed);
    return `0x${Buffer.from(signature).toString('hex')}`;
  }
};
