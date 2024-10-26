import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest } from 'fastify';

import { User } from '../models/user';
import { SIGNING_KEY } from '../constants/environment';
import { NFTInfo, getPhoneNFTs } from './nftController';
import { getNetworkConfig } from '../services/networkService';
import { USDT_ADDRESS, WETH_ADDRESS } from '../constants/contracts';
import { fetchExternalDeposits } from '../services/externalDepositsService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

type Currency = 'USD' | 'UYU' | 'ARS' | 'BRL';

interface TokenInfo {
    symbol: string;
    address: string;
    rateUSD: number;
}

interface FiatQuote {
    currency: Currency;
    rate: number;
}

interface TokenBalance extends TokenInfo {
    balance: string;
}

interface BalanceInfo {
    network: string;
    token: string;
    balance: number;
    balance_conv: Record<Currency, number>;
}

interface BalanceResponse {
    balances: BalanceInfo[];
    totals: Record<Currency, number>;
    certificates: NFTInfo[];
    wallet: string;
}

const API_URLs: [Currency, string][] = [
    ['UYU', 'https://criptoya.com/api/ripio/USDT/UYU'],
    ['ARS', 'https://criptoya.com/api/ripio/USDT/ARS'],
    ['BRL', 'https://criptoya.com/api/ripio/USDT/BRL'],
];

const tokenInfo: TokenInfo[] = [
    { symbol: 'USDT', address: USDT_ADDRESS, rateUSD: 1 },
    { symbol: 'WETH', address: WETH_ADDRESS, rateUSD: 2700 },
];

/**
 * Fetches the balance of a specific token for a given address.
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
 * Fetches fiat quotes from API.
 */
async function getFiatQuotes(): Promise<FiatQuote[]> {
    return Promise.all(
        API_URLs.map(async ([currency, url]) => {
            const response = await fetch(url);
            const data = await response.json();
            return { currency, rate: data.bid };
        }),
    );
}

/**
 * Fetches token balances for a given address.
 */
async function getTokenBalances(signer: ethers.Wallet, address: string): Promise<TokenBalance[]> {
    return Promise.all(
        tokenInfo.map(async (token) => {
            const balance = await getContractBalance(token.address, signer, address);
            return { ...token, balance };
        }),
    );
}

/**
 * Calculates balance information for all tokens.
 */
function calculateBalances(tokenBalances: TokenBalance[], fiatQuotes: FiatQuote[]): BalanceInfo[] {
    return tokenBalances.map(({ symbol, balance, rateUSD }) => {
        const balanceUSD = parseFloat(balance) * rateUSD;
        return {
            network: 'Arbitrum Sepolia',
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
 * Calculates total balances across all currencies.
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
 * Fetches and calculates balance information for a given address.
 */
async function getAddressBalance(address: string, reply: FastifyReply): Promise<FastifyReply> {
    const networkConfig = await getNetworkConfig();
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const signer = new ethers.Wallet(SIGNING_KEY!, provider);

    console.log(`Fetching balance for address: ${address}`);
    const user = await User.findOne({ wallet: address });

    if (!user) {
        return reply.status(404).send({ message: 'User not found' });
    }

    try {
        const [fiatQuotes, tokenBalances, NFTs] = await Promise.all([
            getFiatQuotes(),
            getTokenBalances(signer, address),
            getPhoneNFTs(user.phone_number),
        ]);

        const balances = calculateBalances(tokenBalances, fiatQuotes);
        const totals = calculateTotals(balances);

        const response: BalanceResponse = {
            balances,
            totals,
            certificates: NFTs.nfts,
            wallet: address,
        };

        return await reply.status(200).send(response);
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
}

/**
 * Handles wallet balance request.
 */
export const walletBalance = async (
    request: FastifyRequest<{ Params: { wallet: string } }>,
    reply: FastifyReply,
) => {
    const { wallet } = request.params;

    if (!wallet) {
        console.warn('Wallet address is required');
        return returnErrorResponse(reply, 400, 'Wallet address is required');
    }

    return returnSuccessResponse(reply, "Wallet balance fetched successfully", await getAddressBalance(wallet, reply));
};

/**
 * Handles balance request by phone number.
 */
export const balanceByPhoneNumber = async (request: FastifyRequest, reply: FastifyReply) => {
    const phone = new URL(`http://localhost:3000/${request.url}`).searchParams.get(
        'channel_user_id',
    );

    if (!phone) {
        console.warn('Phone number is required');
        return returnErrorResponse(reply, 400, "Phone number is required")
    }

    try {
        const user = await User.findOne({ phone_number: phone });

        if (!user) {
            console.warn(`User not found for phone number: ${phone}`);
            return await returnErrorResponse(reply, 404, "User not found")
        }

        return await returnSuccessResponse(reply, "Wallet balance fetched successfully", await getAddressBalance(user.wallet, reply));
    } catch (error) {
        console.error('Error fetching user balance:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

/**
 * Handles the query for external deposits made to ChatterPay wallets
 * @param request Fastify Request
 * @param reply Fastify Reply
 */
export const checkExternalDeposits = async (request: FastifyRequest, reply: FastifyReply) => {
    const depositsStatus = await fetchExternalDeposits();

    return reply.status(200).send({ status: depositsStatus });
};