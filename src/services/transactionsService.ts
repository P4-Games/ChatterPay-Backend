import axios from 'axios';
import { ethers, BigNumber } from 'ethers';

import { USDT_ADDRESS, WETH_ADDRESS } from '../constants/contracts';

/** URLs y API Keys de los escaners */
const SCROLL_TESTNET_API = 'https://api-sepolia.scrollscan.com/api';
const SEPOLIA_API = 'https://api-sepolia.etherscan.io/api';
const SCROLL_API_KEY = process.env?.SCROLLSCAN_API_KEY ?? "";
const SEPOLIA_API_KEY = process.env?.ETHERSCAN_API_KEY ?? "";

const WALLETS_TO_MONITOR: string[] = ['WALLET1', 'WALLET2', 'WALLET3'];

/** Ethereum Provider */
const provider: ethers.providers.Provider = new ethers.providers.JsonRpcProvider('URL_DEL_PROVEEDOR');

/** Represents the wallet balances */
interface WalletBalance {
    eth: BigNumber;
    usdt: BigNumber;
    usdc: BigNumber;
}

/** Map to store the last known balance */
const lastKnownBalances: Map<string, WalletBalance> = new Map();

/** Represents a deposit */
interface DepositTransaction {
    hash: string;
    value: BigNumber;
    url: string;
}

/**
 * Obtains ERC20 balance of an address
 * @param tokenAddress - Contract address of the token
 * @param walletAddress - User wallet address
 * @returns Token balance as a BigNumber
 */
async function getTokenBalance(tokenAddress: string, walletAddress: string): Promise<BigNumber> {
    const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider
    );
    return tokenContract.balanceOf(walletAddress);
}


/**
 * Verifies the balances and deposits for all the tracked wallets
 */
async function checkBalancesAndDeposits(): Promise<void> {
    console.log('Verificando balances y depósitos...');

    const balanceChecks = WALLETS_TO_MONITOR.map(async (wallet) => {
        try {
            const ethBalance = await provider.getBalance(wallet);
            const usdtBalance = await getTokenBalance(USDT_ADDRESS, wallet);
            const usdcBalance = await getTokenBalance(WETH_ADDRESS, wallet);

            const lastBalance = lastKnownBalances.get(wallet) || {
                eth: BigNumber.from(0),
                usdt: BigNumber.from(0),
                usdc: BigNumber.from(0)
            };

            const balanceChanges = [
                { token: 'ETH', current: ethBalance, last: lastBalance.eth, formatter: ethers.utils.formatEther },
                { token: 'USDT', current: usdtBalance, last: lastBalance.usdt, formatter: (val: BigNumber) => ethers.utils.formatUnits(val, 6) },
                { token: 'USDC', current: usdcBalance, last: lastBalance.usdc, formatter: (val: BigNumber) => ethers.utils.formatUnits(val, 6) }
            ];

            const changedBalances = balanceChanges.filter(({ current, last }) => current.gt(last));

            const depositChecks = changedBalances.map(async ({ token, current, last, formatter }) => {
                const deposit = current.sub(last);
                console.log(`Detectado cambio en balance de ${token} - Nuevo balance: ${formatter(current)} ${token}`);

                if (token === 'ETH') {
                    const depositTxs = await findApproximateDepositTransactions(wallet, deposit);
                    if (depositTxs.length > 0) {
                        console.log(`Depósitos aproximados encontrados:`);
                        depositTxs.forEach(tx => {
                            console.log(`- ${ethers.utils.formatEther(tx.value)} ETH`);
                            console.log(`  Hash: ${tx.hash}`);
                            console.log(`  URL: ${tx.url}`);
                        });
                    }
                }
            });

            await Promise.all(depositChecks);

            lastKnownBalances.set(wallet, {
                eth: ethBalance,
                usdt: usdtBalance,
                usdc: usdcBalance
            });

        } catch (error) {
            console.error(`Error al verificar el balance de ${wallet}:`, error);
        }
    });

    await Promise.all(balanceChecks);
}

/**
 * Search for transactions in two networks
 * @param wallet - Wallet address
 * @param depositAmount - Deposit amount
 * @returns Approximate deposit transactions array
 */
async function findApproximateDepositTransactions(wallet: string, depositAmount: BigNumber): Promise<DepositTransaction[]> {
    let depositTxs = await findApproximateDepositTransactionsOnNetwork(wallet, depositAmount, SCROLL_TESTNET_API, SCROLL_API_KEY);
    if (depositTxs.length === 0) {
        depositTxs = await findApproximateDepositTransactionsOnNetwork(wallet, depositAmount, SEPOLIA_API, SEPOLIA_API_KEY);
    }
    return depositTxs;
}

/**
 * Search for deposit transactions in a specified network.
 * @param wallet - Wallet address
 * @param depositAmount - Deposit amount
 * @param apiUrl - API URL 
 * @param apiKey - API KEY
 * @returns Approximate deposit transactions array
 */
async function findApproximateDepositTransactionsOnNetwork(
    wallet: string,
    depositAmount: BigNumber,
    apiUrl: string,
    apiKey: string
): Promise<DepositTransaction[]> {
    try {
        const response = await axios.get(apiUrl, {
            params: {
                module: 'account',
                action: 'txlist',
                address: wallet,
                startblock: 0,
                endblock: 99999999,
                sort: 'desc',
                apikey: apiKey
            }
        });

        if (response.data.status === '1' && response.data.result.length > 0) {
            const oneHourAgo = Date.now() - 3600000; // 1 hora en milisegundos
            const relevantTxs = response.data.result
                .filter((tx: {
                    to: string,
                    timeStamp: string,
                    value: string,
                }) =>
                    tx.to.toLowerCase() === wallet.toLowerCase() &&
                    parseInt(tx.timeStamp, 10) * 1000 > oneHourAgo &&
                    BigNumber.from(tx.value).gt(0)
                )
                .map((tx: {
                    hash: string,
                    value: string,
                }) => ({
                    hash: tx.hash,
                    value: BigNumber.from(tx.value),
                    url: apiUrl.includes('scrollscan')
                        ? `https://sepolia.scrollscan.com/tx/${tx.hash}`
                        : `https://sepolia.etherscan.io/tx/${tx.hash}`
                }));

            return relevantTxs.reduce((matchingTxs: DepositTransaction[], tx: { value: { lte: (arg0: ethers.BigNumber) => unknown; gt: (arg0: ethers.BigNumber) => unknown; }; }) => {
                const remainingAmount = depositAmount.sub(matchingTxs.reduce((sum, mtx) => sum.add(mtx.value), BigNumber.from(0)));
                if (remainingAmount.lte(0)) return matchingTxs;

                if (tx.value.lte(remainingAmount) ||
                    (tx.value.gt(remainingAmount) && tx.value.lte(depositAmount.mul(110).div(100)))) {
                    return [...matchingTxs, tx];
                }
                return matchingTxs;
            }, []);
        }

        console.log(`No se encontraron transacciones de depósito aproximadas en la red.`);
        return [];
    } catch (error) {
        console.error("Error al buscar las transacciones de depósito:", error);
        return [];
    }
}

// Exportamos las funciones y tipos principales para su uso en otros módulos
export {
    WalletBalance,
    DepositTransaction,
    checkBalancesAndDeposits,
    findApproximateDepositTransactions
};