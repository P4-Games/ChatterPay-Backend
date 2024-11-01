import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { User } from '../models/user';
import { getPhoneNFTs } from './nftController';
import { SIGNING_KEY } from '../constants/environment';
import { fetchExternalDeposits } from '../services/externalDepositsService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

/**
 * Supported fiat currencies for conversion
 */
type Currency = 'USD' | 'UYU' | 'ARS' | 'BRL';

/**
 * Basic token information including price
 */
interface TokenInfo {
    symbol: string;
    address: string;
    rateUSD: number;
}

/**
 * Fiat currency quote information
 */
interface FiatQuote {
    currency: Currency;
    rate: number;
}

/**
 * Token information including balance
 */
interface TokenBalance extends TokenInfo {
    balance: string;
}

/**
 * Detailed balance information for a token including conversions
 */
interface BalanceInfo {
    network: string;
    token: string;
    balance: number;
    balance_conv: Record<Currency, number>;
}

/**
 * API endpoints for fiat currency conversion rates
 */
const API_URLs: [Currency, string][] = [
    ['UYU', 'https://criptoya.com/api/ripio/USDT/UYU'],
    ['ARS', 'https://criptoya.com/api/ripio/USDT/ARS'],
    ['BRL', 'https://criptoya.com/api/ripio/USDT/BRL'],
];

/**
 * Fetches token prices from Binance API using USDT pairs
 * @param symbols - Array of token symbols to fetch prices for
 * @returns Map of token symbols to their USD prices
 */
async function getTokenPrices(symbols: string[]): Promise<Map<string, number>> {
    try {
        const priceMap = new Map<string, number>();
        
        // USDT is always 1 USD
        priceMap.set('USDT', 1);
        
        // Filter out USDT as we already set its price
        const symbolsToFetch = symbols.filter(s => s !== 'USDT');
        
        if (symbolsToFetch.length === 0) return priceMap;

        // Get prices for all symbols against USDT
        const promises = symbolsToFetch.map(async (symbol) => {
            try {
                symbol = symbol.replace('WETH', 'ETH');
                const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
                const data = await response.json();
                if (data.price) {
                    console.log(`Price for ${symbol}: ${data.price} USDT`);
                    priceMap.set(symbol.replace('ETH', 'WETH'), parseFloat(data.price));
                } else {
                    console.warn(`No price found for ${symbol}USDT`);
                    priceMap.set(symbol.replace('ETH', 'WETH'), 0);
                }
            } catch (error) {
                console.error(`Error fetching price for ${symbol}:`, error);
                priceMap.set(symbol, 0);
            }
        });

        await Promise.all(promises);
        return priceMap;
    } catch (error) {
        console.error('Error fetching token prices from Binance:', error);
        // Return a map with 0 prices in case of error, except USDT which is always 1
        return new Map(symbols.map(symbol => [symbol, symbol === 'USDT' ? 1 : 0]));
    }
}

/**
 * Gets token information from the global state and current prices
 * @param fastify - Fastify instance containing global state
 * @returns Array of tokens with current price information
 */
async function getTokenInfo(fastify: FastifyInstance): Promise<TokenInfo[]> {
    const { tokens, networkConfig } = fastify;
    const chainTokens = tokens.filter(token => token.chain_id === networkConfig.chain_id);
    
    // Get all unique symbols
    const symbols = [...new Set(chainTokens.map(token => token.symbol))];
    
    // Fetch current prices from Binance
    const prices = await getTokenPrices(symbols);
    
    return chainTokens.map(token => ({
        symbol: token.symbol,
        address: token.address,
        rateUSD: prices.get(token.symbol) || 0
    }));
}

/**
 * Fetches the balance of a specific token for a given address
 * @param contractAddress - Token contract address
 * @param signer - Ethereum wallet signer
 * @param address - Address to check balance for
 * @returns Token balance as a string
 */
async function getContractBalance(
    contractAddress: string,
    signer: ethers.Wallet,
    address: string,
): Promise<string> {
    try {
        const erc20 = new ethers.Contract(
            contractAddress,
            ['function balanceOf(address owner) view returns (uint256)'],
            signer,
        );
        const balance = await erc20.balanceOf(address);
        return ethers.utils.formatUnits(balance, 18);
    } catch (error) {
        console.error(
            `Error getting balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        return '0';
    }
}

/**
 * Fetches fiat quotes from external APIs
 * @returns Array of fiat currency quotes
 */
async function getFiatQuotes(): Promise<FiatQuote[]> {
    return Promise.all(
        API_URLs.map(async ([currency, url]) => {
            try {
                const response = await fetch(url);
                const data = await response.json();
                return { currency, rate: data.bid };
            } catch (error) {
                console.error(`Error fetching ${currency} quote:`, error);
                return { currency, rate: 1 }; // Fallback to 1:1 rate
            }
        }),
    );
}

/**
 * Fetches token balances for a given address
 * @param signer - Ethereum wallet signer
 * @param address - Address to check balances for
 * @param fastify - Fastify instance containing global state
 * @returns Array of token balances
 */
async function getTokenBalances(
    signer: ethers.Wallet, 
    address: string,
    fastify: FastifyInstance
): Promise<TokenBalance[]> {
    const tokenInfo = await getTokenInfo(fastify);
    return Promise.all(
        tokenInfo.map(async (token) => {
            const balance = await getContractBalance(token.address, signer, address);
            return { ...token, balance };
        }),
    );
}

/**
 * Calculates balance information for all tokens including fiat conversions
 * @param tokenBalances - Array of token balances
 * @param fiatQuotes - Array of fiat currency quotes
 * @param networkName - Name of the blockchain network
 * @returns Array of detailed balance information
 */
function calculateBalances(
    tokenBalances: TokenBalance[], 
    fiatQuotes: FiatQuote[],
    networkName: string
): BalanceInfo[] {
    return tokenBalances.map(({ symbol, balance, rateUSD }) => {
        const balanceUSD = parseFloat(balance) * rateUSD;
        return {
            network: networkName,
            token: symbol,
            balance: parseFloat(balance),
            balance_conv: {
                USD: balanceUSD,
                UYU: balanceUSD * (fiatQuotes.find((q) => q.currency === 'UYU')?.rate ?? 1),
                ARS: balanceUSD * (fiatQuotes.find((q) => q.currency === 'ARS')?.rate ?? 1),
                BRL: balanceUSD * (fiatQuotes.find((q) => q.currency === 'BRL')?.rate ?? 1),
            },
        };
    });
}

/**
 * Calculates total balances across all currencies
 * @param balances - Array of balance information
 * @returns Record of currency totals
 */
function calculateTotals(balances: BalanceInfo[]): Record<Currency, number> {
    return balances.reduce(
        (acc, balance) => {
            (Object.keys(balance.balance_conv) as Currency[]).forEach((currency) => {
                acc[currency] = (acc[currency] || 0) + balance.balance_conv[currency];
            });
            return acc;
        },
        {} as Record<Currency, number>,
    );
}


/**
 * Route handler for checking external deposits
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Promise resolving to deposits status
 */
export const checkExternalDeposits = async (
    request: FastifyRequest, 
    reply: FastifyReply
) => {
    const depositsStatus = await fetchExternalDeposits();
    return reply.status(200).send({ status: depositsStatus });
};

/**
 * Fetches and calculates balance information for a given address
 * @param address - Address to get balance for
 * @param reply - Fastify reply object
 * @param fastify - Fastify instance containing global state
 * @returns Fastify reply with balance information
 */
async function getAddressBalance(
    address: string, 
    reply: FastifyReply,
    fastify: FastifyInstance
): Promise<FastifyReply> {
    const { networkConfig } = fastify;
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const signer = new ethers.Wallet(SIGNING_KEY!, provider);

    console.log(`Fetching balance for address: ${address} on network ${networkConfig.name}`);
    const user = await User.findOne({ wallet: address });

    if (!user) {
        return returnErrorResponse(reply, 404, 'User not found');
    }

    try {
        const [fiatQuotes, tokenBalances, NFTs] = await Promise.all([
            getFiatQuotes(),
            getTokenBalances(signer, address, fastify),
            getPhoneNFTs(user.phone_number),
        ]);

        const balances = calculateBalances(tokenBalances, fiatQuotes, networkConfig.name);
        const totals = calculateTotals(balances);

        const response = {
            balances,
            totals,
            certificates: NFTs.nfts,
            wallet: address,
        };

        return await returnSuccessResponse(reply, "Wallet balance fetched successfully", response);
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        return returnErrorResponse(reply, 500, 'Internal Server Error');
    }
}

/**
 * Route handler for getting wallet balance
 */
export const walletBalance = async (
    request: FastifyRequest<{ Params: { wallet: string } }>,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    const { wallet } = request.params;

    if (!wallet) {
        console.warn('Wallet address is required');
        return returnErrorResponse(reply, 400, 'Wallet address is required');
    }

    return getAddressBalance(wallet, reply, request.server);
};

/**
 * Route handler for getting balance by phone number
 */
export const balanceByPhoneNumber = async (
    request: FastifyRequest, 
    reply: FastifyReply
): Promise<FastifyReply> => {
    const phone = new URL(`http://localhost:3000/${request.url}`).searchParams.get(
        'channel_user_id',
    );

    if (!phone) {
        console.warn('Phone number is required');
        return returnErrorResponse(reply, 400, "Phone number is required");
    }

    try {
        const user = await User.findOne({ phone_number: phone });

        if (!user) {
            console.warn(`User not found for phone number: ${phone}`);
            return await returnErrorResponse(reply, 404, "User not found");
        }

        return await getAddressBalance(user.wallet, reply, request.server);
    } catch (error) {
        console.error('Error fetching user balance:', error);
        return returnErrorResponse(reply, 500, 'Internal Server Error');
    }
}