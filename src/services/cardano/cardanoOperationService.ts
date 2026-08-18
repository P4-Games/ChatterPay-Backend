/**
 * A Cardano transfer as the product means it: from a phone number, to a phone number or an address.
 *
 * This is the layer between the request handler and the chain. It resolves who the two parties are,
 * turns a typed amount into lovelace, and hands the result to `cardanoTransferService`, which knows
 * nothing about users or the database.
 *
 * The reason the split exists: everything below it is pure enough to test against fabricated UTxOs,
 * and everything here needs Mongo. Keeping the chain logic free of the database is what makes the
 * borders — dust change, an undetermined submit — testable at all.
 *
 * @see CARDANO_INTEGRATION_PLAN.md §6.2
 */

import { getCardanoConfig } from '../../config/cardanoConfig';
import { lovelaceToAda, toBaseUnits } from '../../helpers/cardanoAmountHelper';
import { Logger } from '../../helpers/loggerHelper';
import Token from '../../models/tokenModel';
import type { IUser } from '../../models/userModel';
import { assetUnit, type CardanoAsset } from '../../types/cardanoType';
import { decodeCardanoAddress } from './cardanoAddressService';
import { buildCardanoProvider, type CardanoProvider } from './cardanoProviderService';
import { executeCardanoTransfer } from './cardanoTransferService';
import { ensureCardanoWalletForUser, getOrCreateCardanoWallet } from './cardanoWalletService';

/** The `tokens.address` sentinel ADA uses. ADA has no policy and no contract. */
export const ADA_ADDRESS_PREFIX = 'cardano:';

/** A Cardano asset resolved from a token symbol. */
export interface ResolvedCardanoToken {
  /** Ticker as configured. */
  symbol: string;
  /** Whether this is ADA itself rather than a native asset. */
  isAda: boolean;
  /** Decimals the asset carries, from the token document. */
  decimals: number;
  /** Policy and name, absent for ADA. */
  asset?: CardanoAsset;
}

/**
 * Resolves a token symbol into the asset the chain understands.
 *
 * The `tokens` collection is the only source: a policy id hardcoded in the repository is a policy
 * id nobody re-verifies, and the failure mode of a wrong one is not an error — it is a perfectly
 * valid transfer of an asset the user did not mean to move.
 *
 * @param symbol - Ticker as the user or the bot named it.
 * @param chainId - Cardano chain id to look the token up on.
 * @returns The resolved asset.
 * @throws Error `CARDANO_UNKNOWN_TOKEN` when the symbol is not configured for this network.
 * @throws Error `CARDANO_TOKEN_MISCONFIGURED` when the document exists but its `address` is not a
 *   usable asset unit — refused loudly rather than turned into a plausible-looking transfer.
 */
export async function resolveCardanoToken(
  symbol: string,
  chainId: number
): Promise<ResolvedCardanoToken> {
  const ticker = symbol.trim();
  const token = await Token.findOne({
    symbol: new RegExp(`^${ticker}$`, 'i'),
    chain_id: chainId
  });
  if (!token) {
    throw new Error(`CARDANO_UNKNOWN_TOKEN: '${ticker}' is not configured on chain ${chainId}`);
  }

  const unit = (token.address ?? '').trim();
  if (unit.startsWith(ADA_ADDRESS_PREFIX)) {
    return { symbol: token.symbol, isAda: true, decimals: token.decimals };
  }

  // A native asset's unit is `policyId` (28 bytes) followed by `assetName` (0–32 bytes), all hex.
  // Anything shorter than the policy alone, or not hex, is a misconfigured row.
  const normalised = unit.toLowerCase();
  if (!/^[0-9a-f]{56}([0-9a-f]{2})*$/.test(normalised)) {
    throw new Error(
      `CARDANO_TOKEN_MISCONFIGURED: '${ticker}' has address '${unit}', which is neither the ADA ` +
        `sentinel nor a policyId+assetName unit`
    );
  }

  return {
    symbol: token.symbol,
    isAda: false,
    decimals: token.decimals,
    asset: { policyId: normalised.slice(0, 56), assetName: normalised.slice(56) }
  };
}

/** How a destination was named, and what it resolved to. */
export interface ResolvedCardanoDestination {
  /** Bech32 address the funds will go to. */
  address: string;
  /** The recipient, when the destination was a phone number of a ChatterPay user. */
  user: IUser | null;
  /** Whether the caller gave an address directly or a phone number. */
  resolvedFrom: 'address' | 'phone';
}

/** What a completed (or refused) operation reports back. */
export interface CardanoOperationResult {
  success: boolean;
  transactionHash: string;
  /** Ticker actually moved. */
  tokenSymbol: string;
  /** Network fee actually paid, in ADA, as a plain decimal string. */
  networkFeeAda: string;
  /** ChatterPay fee collected in this transaction, in ADA. "0" when not collecting. */
  feeCollectedAda: string;
  /**
   * ADA that left the sender for the destination.
   *
   * Equal to the amount on an ADA transfer. On a token transfer it is the ADA the protocol forces
   * to travel with the token — around 1.2 ADA — which the sender pays and the recipient receives.
   * Surfaced because otherwise the sender's ADA balance drops by more than the fee with nothing to
   * explain it.
   */
  sentAda: string;
  explorerUrl: string;
  /** Sender's Cardano address. */
  fromAddress: string;
  /** Destination address the funds went to. */
  toAddress: string;
  /** The recipient user, when the destination was a phone number. */
  toUser: IUser | null;
  errorCode: string;
  error: string;
}

/**
 * Resolves a destination that may be an address or a phone number.
 *
 * A phone number that belongs to nobody yet still resolves: the address is a function of the phone
 * number, so the recipient gets one whether or not they have ever used Cardano. That is the whole
 * argument for anticipated addresses, and it is why sending to a new user works on the first try.
 *
 * @param destination - Bech32 address or phone number.
 * @returns The address to pay, and the user behind it when there is one.
 * @throws Error `CARDANO_INVALID_DESTINATION` when the value is neither.
 */
export async function resolveCardanoDestination(
  destination: string
): Promise<ResolvedCardanoDestination> {
  const trimmed = destination.trim();

  // An address is recognised by decoding it, not by its prefix: that way a mistyped address is
  // refused here rather than treated as a phone number and silently turned into someone's wallet.
  if (trimmed.startsWith('addr')) {
    const decoded = decodeCardanoAddress(trimmed);
    if (!decoded) {
      throw new Error(`CARDANO_INVALID_DESTINATION: '${trimmed}' is not a readable address`);
    }
    return { address: trimmed, user: null, resolvedFrom: 'address' };
  }

  if (!/^\+?\d{8,15}$/.test(trimmed)) {
    throw new Error(
      `CARDANO_INVALID_DESTINATION: '${trimmed}' is neither a Cardano address nor a phone number`
    );
  }

  const { user, wallet } = await getOrCreateCardanoWallet(trimmed);
  return { address: wallet.address, user, resolvedFrom: 'phone' };
}

/** Everything a phone-to-phone transfer needs. */
export interface CardanoOperationInput {
  /** Sender: an existing ChatterPay user. */
  fromUser: IUser;
  /** Destination: a bech32 address or a phone number. */
  to: string;
  /** Amount, as typed, in the token's own units. */
  amount: string;
  /** Ticker to move. Defaults to ADA. */
  token?: string;
  /** Correlation key for the logs. */
  logKey: string;
  /** Provider override, for tests. */
  provider?: CardanoProvider;
}

function failure(code: string, message: string, symbol = 'ADA'): CardanoOperationResult {
  return {
    success: false,
    transactionHash: '',
    tokenSymbol: symbol,
    networkFeeAda: '0.000000',
    feeCollectedAda: '0.000000',
    sentAda: '0.000000',
    explorerUrl: '',
    fromAddress: '',
    toAddress: '',
    toUser: null,
    errorCode: code,
    error: message
  };
}

/**
 * Sends ADA from a ChatterPay user to a phone number or a Cardano address.
 *
 * @param input - Sender, destination, amount.
 * @returns The outcome. Never throws: the caller is a request handler that has already told the
 *   user their operation started.
 */
export async function executeCardanoOperation(
  input: CardanoOperationInput
): Promise<CardanoOperationResult> {
  const { fromUser, to, amount, logKey } = input;
  const symbol = (input.token ?? 'ADA').trim() || 'ADA';
  const config = getCardanoConfig();

  if (!config.enabled) {
    return failure(
      'CARDANO_DISABLED',
      `Cardano is not available: ${config.disabledReason}`,
      symbol
    );
  }

  // Resolved from the database before anything else: the asset decides how many decimals the
  // amount has, so parsing it first would parse it against the wrong scale.
  let token: ResolvedCardanoToken;
  try {
    token = await resolveCardanoToken(symbol, config.chainId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      /^CARDANO_[A-Z_]+/.exec(message)?.[0] ?? 'CARDANO_UNKNOWN_TOKEN',
      message,
      symbol
    );
  }

  let quantity: bigint;
  try {
    quantity = toBaseUnits(amount, token.decimals, token.symbol);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      /^CARDANO_[A-Z_]+/.exec(message)?.[0] ?? 'CARDANO_INVALID_AMOUNT',
      message,
      symbol
    );
  }

  // On a token transfer the lovelace figure is left at zero so the builder attaches the protocol
  // minimum. Naming an amount there would mean the sender guessing a number the chain dictates.
  const amountLovelace = token.isAda ? quantity : 0n;
  const asset = token.isAda ? undefined : { ...token.asset!, quantity };

  let destination: ResolvedCardanoDestination;
  try {
    // Resolved before the sender's wallet is touched: a destination that cannot be resolved is a
    // refusal that should cost nothing, not a half-provisioned recipient.
    destination = await resolveCardanoDestination(to);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure('CARDANO_INVALID_DESTINATION', message, symbol);
  }

  let senderAddress: string;
  try {
    senderAddress = (await ensureCardanoWalletForUser(fromUser)).address;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      /^CARDANO_[A-Z_]+/.exec(message)?.[0] ?? 'CARDANO_WALLET_ERROR',
      message,
      symbol
    );
  }

  Logger.log(
    'executeCardanoOperation',
    logKey,
    `${senderAddress} -> ${destination.address} (${destination.resolvedFrom}), ` +
      `${amount} ${token.symbol}${token.isAda ? '' : ` [${assetUnit(token.asset!)}]`}`
  );

  const result = await executeCardanoTransfer({
    fromPhoneNumber: fromUser.phone_number,
    toAddress: destination.address,
    amountLovelace,
    asset,
    provider: input.provider ?? buildCardanoProvider(),
    network: config.network,
    chainId: config.chainId,
    ttlSlots: config.ttlSlots,
    depositConfirmations: config.depositConfirmations,
    explorerUrl: config.explorerUrl,
    logKey
  });

  return {
    success: result.success,
    transactionHash: result.transactionHash,
    tokenSymbol: token.symbol,
    networkFeeAda: lovelaceToAda(result.feeLovelace),
    feeCollectedAda: lovelaceToAda(result.feeCollectedLovelace),
    sentAda: lovelaceToAda(result.sentLovelace),
    explorerUrl: result.explorerUrl,
    fromAddress: senderAddress,
    toAddress: destination.address,
    toUser: destination.user,
    errorCode: result.errorCode,
    error: result.error
  };
}
