/**
 * ADA balances, read straight from the chain.
 *
 * There is no contract to call and no `balanceOf`: a Cardano balance is the sum of the unspent
 * outputs an address holds, so this reads UTxOs and adds them up.
 *
 * An output that also carries native assets used to be invisible here, because an ADA transfer
 * could not spend one: its tokens had nowhere to go. That is no longer true — the change output
 * carries them home — so its ADA counts like any other, and a wallet that sent a token stops
 * appearing to have lost the whole output it came out of.
 *
 * What is still reported apart is how much ADA is keeping tokens company. Almost all of it is
 * spendable; roughly one min-ADA of it is not, because the change output that carries the tokens
 * has to hold its own floor. Pricing that floor needs the protocol parameters, so the exact figure
 * is left to whoever has them: the builder refuses precisely, and `adaTransferRequirement`
 * explains it in a sentence.
 */

import { ADA_ADDRESS_PREFIX, getCardanoConfig } from '../../config/cardanoConfig';
import {
  fromBaseUnits,
  lovelaceToAda,
  lovelaceToAdaNumber
} from '../../helpers/cardanoAmountHelper';
import { Logger } from '../../helpers/loggerHelper';
import Token, { type IToken } from '../../models/tokenModel';
import { assetUnit, type CardanoAssetAmount } from '../../types/cardanoType';
import type { TokenBalance } from '../../types/commonType';
import { mongoBlockchainService } from '../mongo/mongoBlockchainService';
import { decodeCardanoAddress } from './cardanoAddressService';
import {
  buildCardanoProvider,
  type CardanoProvider,
  logCardanoProviderError
} from './cardanoProviderService';
import { adaOnlyBalance, selectableBalance, totalAssets } from './cardanoTxService';

/**
 * The whole Cardano token catalogue for this network, as configured.
 *
 * @returns Every token row on the Cardano chain.
 */
async function cardanoCatalogue(): Promise<IToken[]> {
  return Token.find({ chain_id: getCardanoConfig().chainId });
}

/**
 * Looks up the tickers and decimals of assets this deployment has configured.
 *
 * @param held - Assets the address holds.
 * @returns A map from asset unit to its catalogue entry, for the ones that are configured.
 */
async function configuredAssets(
  held: readonly CardanoAssetAmount[]
): Promise<Map<string, { symbol: string; decimals: number }>> {
  const units = held.map(assetUnit);
  const tokens = await Token.find({
    chain_id: getCardanoConfig().chainId,
    address: { $in: units }
  });
  return new Map(
    tokens.map((token) => [
      token.address.toLowerCase(),
      { symbol: token.symbol, decimals: token.decimals }
    ])
  );
}

/** How much of one native asset an address holds. */
export interface CardanoAssetBalance {
  /** `policyId + assetName`, the way providers name an asset. */
  unit: string;
  policyId: string;
  assetName: string;
  /** Ticker, when the asset is one this deployment has configured. */
  symbol?: string;
  /** Raw quantity in the asset's base unit. */
  quantity: string;
  /** Quantity scaled by the asset's decimals, when known. */
  balance?: string;
}

/** What an address holds, split by what an ADA transfer can actually move. */
export interface CardanoBalance {
  /** The address queried. */
  address: string;
  /** Everything the address holds. */
  totalAda: string;
  /** What an ADA transfer can reach. Equal to {@link totalAda} but for a rounding of min-ADA. */
  spendableAda: string;
  /** Spendable amount as a number, for the fields that store balances numerically. */
  spendable: number;
  /**
   * ADA sitting in outputs that also carry native assets.
   *
   * Informational, not a deduction: this ADA is spendable. It is reported because it is the part of
   * the balance whose availability has a caveat — the change output carrying those tokens keeps one
   * min-ADA of it behind.
   */
  lockedWithAssetsAda: string;
  /** Native assets held, one entry per asset. */
  assets: CardanoAssetBalance[];
  /** Number of unspent outputs. High counts are what eventually make a transfer too large. */
  utxoCount: number;
}

const ZERO: Omit<CardanoBalance, 'address'> = {
  totalAda: '0.000000',
  spendableAda: '0.000000',
  spendable: 0,
  lockedWithAssetsAda: '0.000000',
  assets: [],
  utxoCount: 0
};

/**
 * Whether a string is an address this deployment can read a balance for.
 *
 * @param address - Candidate address.
 * @returns `true` for a checksum-valid Cardano address of the configured network.
 */
export function isCardanoWalletAddress(address: string): boolean {
  const decoded = decodeCardanoAddress(address);
  return decoded !== null && decoded.network === getCardanoConfig().network;
}

/**
 * The ADA an address holds.
 *
 * @param address - Bech32 Cardano address.
 * @param provider - Provider override, for tests.
 * @returns The balance. A provider failure yields zeroes rather than an exception: this is a read
 *   on a dashboard path, and a balance endpoint that throws takes the whole wallet view down with
 *   it. The failure is logged with its classification.
 */
export async function getCardanoBalance(
  address: string,
  provider?: CardanoProvider
): Promise<CardanoBalance> {
  try {
    const utxos = await (provider ?? buildCardanoProvider()).utxosFor(address);
    const total = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    const spendable = selectableBalance(utxos);
    const held = totalAssets(utxos);

    // Tickers and decimals come from the token catalogue: the chain knows the policy and the
    // quantity, and nothing else. An asset nobody configured is still reported — hiding it would
    // make the balance disagree with any explorer — just without a ticker or a scaled figure.
    const configured = held.length > 0 ? await configuredAssets(held) : new Map();

    return {
      address,
      totalAda: lovelaceToAda(total),
      spendableAda: lovelaceToAda(spendable),
      spendable: lovelaceToAdaNumber(spendable),
      // Against the ADA-only figure, not the sponsor's spendable one: this reports what a user
      // sees sitting beside a token, and the sponsor's view of what it may reach for is a
      // different question with a different answer.
      lockedWithAssetsAda: lovelaceToAda(total - adaOnlyBalance(utxos)),
      assets: held.map((asset) => {
        const unit = assetUnit(asset);
        const known = configured.get(unit);
        return {
          unit,
          policyId: asset.policyId,
          assetName: asset.assetName,
          symbol: known?.symbol,
          quantity: asset.quantity.toString(),
          balance: known ? fromBaseUnits(asset.quantity, known.decimals) : undefined
        };
      }),
      utxoCount: utxos.length
    };
  } catch (error) {
    logCardanoProviderError('getCardanoBalance', error);
    Logger.warn(
      'getCardanoBalance',
      `Returning zero balance for ${address} after provider failure`
    );
    return { address, ...ZERO };
  }
}

/**
 * The Cardano rows of a portfolio, built from the token catalogue.
 *
 * Every display attribute — ticker, decimals, `display_decimals`, `type` — comes from the `tokens`
 * collection, the same place the EVM rows get theirs. Hardcoding them here would mean a token could
 * be renamed, re-scaled or delisted in the database and this one code path would keep announcing
 * the old values; and it would be the same mistake as hardcoding a policy id, only quieter.
 *
 * Tokens configured but not held are reported at zero rather than omitted, which is what lets the
 * user see what they *can* receive on this network.
 *
 * @param address - Bech32 address to read.
 * @param rateFor - Resolves a USD rate for a ticker. Assets with no price feed get `0`.
 * @param provider - Provider override, for tests.
 * @returns The network's display name and one balance row per configured or held asset.
 */
export async function getCardanoTokenBalances(
  address: string,
  rateFor: (symbol: string) => number,
  provider?: CardanoProvider
): Promise<{ networkName: string; balances: TokenBalance[]; raw: CardanoBalance }> {
  const config = getCardanoConfig();
  const [raw, catalogue, network] = await Promise.all([
    getCardanoBalance(address, provider),
    cardanoCatalogue(),
    mongoBlockchainService.getBlockchain(config.chainId)
  ]);

  const heldByUnit = new Map(raw.assets.map((asset) => [asset.unit, asset]));
  const balances: TokenBalance[] = catalogue.map((token) => {
    const unit = token.address.toLowerCase();
    // ADA is the row whose address is the sentinel rather than an asset unit: the chain's own coin
    // has no policy and no contract, and its balance is the spendable lovelace.
    const isAda = unit.startsWith(ADA_ADDRESS_PREFIX);
    const held = heldByUnit.get(unit);
    const balance = isAda
      ? raw.spendableAda
      : fromBaseUnits(BigInt(held?.quantity ?? '0'), token.decimals);

    return {
      symbol: token.symbol,
      address: token.address,
      type: token.type,
      rateUSD: rateFor(token.symbol),
      display_decimals: token.display_decimals,
      display_symbol: token.display_symbol,
      balance
    };
  });

  // Held but not configured: still reported, because hiding it would make the balance disagree with
  // any explorer. Without a catalogue row there is no ticker and no scale, so the unit and the raw
  // quantity are all that can honestly be shown.
  const configuredUnits = new Set(catalogue.map((token) => token.address.toLowerCase()));
  for (const asset of raw.assets) {
    if (configuredUnits.has(asset.unit)) continue;
    balances.push({
      symbol: asset.symbol ?? asset.unit.slice(0, 12),
      address: asset.unit,
      type: 'variable',
      rateUSD: 0,
      display_decimals: 0,
      display_symbol: asset.symbol ?? asset.unit.slice(0, 12),
      balance: asset.quantity
    });
  }

  return {
    networkName: network?.name ?? (config.network === 'mainnet' ? 'Cardano' : 'Cardano Preprod'),
    balances,
    raw
  };
}

/**
 * Tickers configured on the Cardano network.
 *
 * Used to decide which prices to ask for: the catalogue is what says which assets exist, so a
 * token added to the database starts being priced without a code change.
 *
 * @returns Every configured ticker on this network.
 */
export async function getCardanoTokenSymbols(): Promise<string[]> {
  return (await cardanoCatalogue()).map((token) => token.symbol);
}
