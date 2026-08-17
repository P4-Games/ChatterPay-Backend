import { type Document, model, Schema } from 'mongoose';

import { DEFAULT_CHAIN_ID, SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT } from '../config/constants';

export interface IPolymarketAccount {
  polygon_address: string;
  api_credentials_encrypted: string;
  terms_accepted_version: number;
  terms_accepted_at: Date | null;
  created_at: Date;
  wallet_type: 'safe' | 'deposit';
}

/**
 * What kind of address a wallet entry holds.
 *
 * Absent on every wallet written before Cardano existed, and read as `evm_aa` when missing: those
 * are all ERC-4337 accounts. A Cardano entry has no proxy, no factory and no EOA — it carries the
 * same bech32 address in `wallet_proxy` and `wallet_eoa` so that every existing reader (bot,
 * dashboard, balance) keeps working unchanged.
 *
 * `cardano_base` is a CIP-19 type-0 address: payment credential plus staking credential, the
 * staking one written into the address but registered nowhere. `cardano_enterprise` was the shape
 * of the first implementation and **was never written to any database** — it is absent from this
 * union on purpose, so that a row carrying it fails loudly rather than being read as current.
 */
export type UserWalletAddressType = 'evm_aa' | 'cardano_base';

export interface IUserWallet {
  wallet_proxy: string;
  wallet_eoa: string;
  created_with_chatterpay_proxy_address: string;
  created_with_factory_address: string;
  chain_id: number;
  status: string;
  alchemy_registered?: boolean; // flag to indicate if the wallet is registered with Alchemy webHook
  /** Address family of this entry. Missing means `evm_aa`. */
  address_type?: UserWalletAddressType;
  /**
   * Raw Ed25519 **payment** public key behind a Cardano address, hex with `0x`.
   *
   * Stored rather than re-derived on every read because it is what goes into the witness of a
   * transaction, and because it lets an address be audited against its key without touching the
   * signing path.
   */
  cardano_public_key?: string;
  /**
   * Raw Ed25519 **staking** public key behind a Cardano address, hex with `0x`.
   *
   * Signs nothing: a transfer is authorised by the payment key alone. It is stored because it is
   * half of what the address hashes, so an address can be audited against both its credentials —
   * and because whatever registers or delegates this stake credential later will need the key, not
   * just the hash the address carries.
   */
  cardano_stake_public_key?: string;
}

export interface IRecoveryQuestion {
  question_id: string;
  answer_hash: string;
  salt: string;
  set_at: Date;
}

export interface ISecurityPin {
  hash: string;
  status: 'active' | 'blocked' | 'not_set';
  failed_attempts: number;
  blocked_until: Date | null;
  last_set_at: Date | null;
  reset_required: boolean;
}

export interface IUserSecurity {
  pin: ISecurityPin;
  recovery_questions: IRecoveryQuestion[];
}

export interface IUser extends Document {
  name: string;
  email: string;
  phone_number: string;
  photo: string;
  code: number;
  creationDate?: Date;
  wallets: IUserWallet[];
  settings?: {
    notifications: {
      language: string;
    };
    security?: IUserSecurity;
  };
  lastOperationDate?: Date;
  operations_in_progress?: {
    transfer: number;
    swap: number;
    mint_nft: number;
    mint_nft_copy: number;
  };
  level: string;
  operations_counters?: {
    transfer: Record<string, number>;
    swap: Record<string, number>;
    mint_nft: Record<string, number>;
    mint_nft_copy: Record<string, number>;
  };
  manteca_user_id?: string;
  chatterpoints_admin?: boolean;
  telegram_id?: string;
  referral_code?: string;
  referral_by_code?: string;
  polymarket_account?: IPolymarketAccount;
}

const walletSchema = new Schema<IUserWallet>(
  {
    wallet_proxy: { type: String, required: true, default: '' },
    wallet_eoa: { type: String, required: true, default: '' },
    created_with_chatterpay_proxy_address: {
      type: String,
      required: false,
      default: ''
    },
    created_with_factory_address: {
      type: String,
      required: false,
      default: ''
    },
    chain_id: { type: Number, required: true, default: DEFAULT_CHAIN_ID },
    status: { type: String, required: true, default: 'active' },
    alchemy_registered: { type: Boolean, required: false, default: false },
    address_type: {
      type: String,
      enum: ['evm_aa', 'cardano_base'],
      required: false
    },
    cardano_public_key: { type: String, required: false },
    cardano_stake_public_key: { type: String, required: false }
  },
  { _id: false }
);

const recoveryQuestionSchema = new Schema<IRecoveryQuestion>(
  {
    question_id: { type: String, required: true },
    answer_hash: { type: String, required: true },
    salt: { type: String, required: true },
    set_at: { type: Date, required: true }
  },
  { _id: false }
);

const securityPinSchema = new Schema<ISecurityPin>(
  {
    hash: { type: String, required: false, default: '' },
    status: { type: String, required: true, default: 'not_set' },
    failed_attempts: { type: Number, required: true, default: 0 },
    blocked_until: { type: Date, required: false, default: null },
    last_set_at: { type: Date, required: false, default: null },
    reset_required: { type: Boolean, required: true, default: false }
  },
  { _id: false }
);

const securitySchema = new Schema<IUserSecurity>(
  {
    pin: { type: securityPinSchema, required: true, default: {} },
    recovery_questions: { type: [recoveryQuestionSchema], required: true, default: [] }
  },
  { _id: false }
);

const userSchema = new Schema<IUser>({
  name: { type: String, required: false },
  email: { type: String, required: false },
  phone_number: { type: String, required: true },
  photo: { type: String, required: false },
  creationDate: { type: Date, required: false },
  code: { type: Number, required: false },
  wallets: { type: [walletSchema], default: [] },
  settings: {
    notifications: {
      language: { type: String, required: true, default: SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT }
    },
    security: { type: securitySchema, required: true, default: {} }
  },
  lastOperationDate: { type: Date, required: false },
  operations_in_progress: {
    transfer: { type: Number, required: false, default: 0 },
    swap: { type: Number, required: false, default: 0 },
    mint_nft: { type: Number, required: false, default: 0 },
    mint_nft_copy: { type: Number, required: false, default: 0 }
  },
  level: { type: String, required: true, default: 'L1' },
  operations_counters: {
    transfer: { type: Map, of: Number, default: {} },
    swap: { type: Map, of: Number, default: {} },
    mint_nft: { type: Map, of: Number, default: {} },
    mint_nft_copy: { type: Map, of: Number, default: {} }
  },
  manteca_user_id: { type: String, required: false, default: '' },
  chatterpoints_admin: { type: Boolean, required: false, default: false },
  telegram_id: { type: String, required: false, default: 0 },
  referral_code: { type: String, required: false, default: '' },
  referral_by_code: { type: String, required: false, default: '' },
  polymarket_account: {
    type: {
      polygon_address: { type: String, required: true },
      api_credentials_encrypted: { type: String, required: true },
      terms_accepted_version: { type: Number, required: false, default: 0 },
      terms_accepted_at: { type: Date, required: false, default: null },
      created_at: { type: Date, required: true, default: Date.now },
      wallet_type: { type: String, enum: ['safe', 'deposit'], default: 'safe' }
    },
    required: false,
    default: undefined,
    _id: false
  }
});

export const UserModel = model<IUser>('User', userSchema, 'users');
