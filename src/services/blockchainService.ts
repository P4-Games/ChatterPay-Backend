import Blockchain, { IBlockchain } from '../models/blockchain';
import { IToken } from '../models/token';

export interface TokenAddresses {
  tokenAddressInput: string;
  tokenAddressOutput: string;
}


/**
 * Retrieves a blockchain by its chain ID.
 *
 * @param chain_id - The unique identifier of the blockchain.
 * @returns A promise that resolves to the blockchain information.
 * @throws Error if the blockchain with the specified chain ID is not found.
 */
export async function getBlockchain(chain_id: number): Promise<IBlockchain> {
  const blockchain: IBlockchain | null = await Blockchain.findOne({ chain_id });
  if (!blockchain) {
    throw new Error(`Blockchain with chain_id ${chain_id} not found`);
  }
  return blockchain;
}


/**
 * Gets token address based on Token symbols
 */
export function getTokenAddress(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  lookUpTokenSymbol: string
): string {

  if (!blockchainTokens) return '';
  
  const chainTokens = blockchainTokens.filter((token) => token.chain_id === blockchainConfig.chain_id);

  const foundToken = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbol.toLowerCase()
  );

  return foundToken?.address ?? '';

}


/**
 * Gets tokens addresses based on Tokens symbols
 */
export function getTokensAddresses(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  lookUpTokenSymbolInput: string,
  lookUpTokenSymbolOutput: string
): TokenAddresses {
  const chainTokens = blockchainTokens.filter((token) => token.chain_id === blockchainConfig.chain_id);

  const foundTokenInput = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbolInput.toLowerCase()
  );
  const foundTokenOutput = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbolOutput.toLowerCase()
  );

  return {
    tokenAddressInput: foundTokenInput?.address ?? '',
    tokenAddressOutput: foundTokenOutput?.address ?? ''
  };
  
}