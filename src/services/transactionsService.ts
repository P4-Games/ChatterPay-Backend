import axios from 'axios';
import { FastifyInstance } from 'fastify';
import { ethers, BigNumber } from 'ethers';

/** Type definitions */
interface WalletBalance {
    eth: BigNumber;
    tokenBalances: Map<string, BigNumber>;
}

interface DepositTransaction {
    hash: string;
    value: BigNumber;
    url: string;
}

interface TokenBalance {
    token: string;
    current: BigNumber;
    last: BigNumber;
    formatter: (val: BigNumber) => string;
}

interface NetworkScanConfig {
    apiUrl: string;
    apiKey: string;
    explorer: string;
}

/** Map to store the last known balance */
const lastKnownBalances: Map<string, WalletBalance> = new Map();

/**
 * Gets the network scan configuration based on chain ID
 */
function getNetworkScanConfig(chainId: number): NetworkScanConfig {
    switch (chainId) {
        case 534351: // Scroll Sepolia
            return {
                apiUrl: 'https://api-sepolia.scrollscan.com/api',
                apiKey: process.env.SCROLL_SCAN_API_KEY || '',
                explorer: 'https://sepolia.scrollscan.com',
            };
        case 11155111: // Ethereum Sepolia
            return {
                apiUrl: 'https://api-sepolia.etherscan.io/api',
                apiKey: process.env.ETHERSCAN_API_KEY || '',
                explorer: 'https://sepolia.etherscan.io',
            };
        default:
            throw new Error(`Unsupported chain ID: ${chainId}`);
    }
}

/**
 * Gets ERC20 balance of an address
 */
async function getTokenBalance(
    tokenAddress: string,
    walletAddress: string,
    provider: ethers.providers.Provider
): Promise<BigNumber> {
    try {
        const tokenContract = new ethers.Contract(
            tokenAddress,
            ['function balanceOf(address) view returns (uint256)'],
            provider
        );
        const balance = await tokenContract.balanceOf(walletAddress);
        
        return balance;
    } catch (error) {
        console.error(`Error getting balance for token ${tokenAddress}:`, error);
        return BigNumber.from(0);
    }
}

/**
 * Process balance changes for a wallet
 */
async function processBalanceChanges(
    wallet: string,
    balanceChanges: TokenBalance[],
    fastify: FastifyInstance
): Promise<void> {
    const changedBalances = balanceChanges.filter(({ current, last }) => current.gt(last));

    await Promise.all(
        changedBalances.map(async ({ token, current, last, formatter }) => {
            const deposit = current.sub(last);
            console.log(
                `Detected ${token} balance change - New balance: ${formatter(current)} ${token}`
            );

            if (token === 'ETH') {
                const depositTxs = await findApproximateDepositTransactions(
                    wallet,
                    deposit,
                    fastify
                );
                if (depositTxs.length > 0) {
                    console.log('Approximate deposits found:');
                    depositTxs.forEach((tx) => {
                        console.log(`- ${ethers.utils.formatEther(tx.value)} ETH`);
                        console.log(`  Hash: ${tx.hash}`);
                        console.log(`  URL: ${tx.url}`);
                    });
                }
            }
        })
    );
}

/**
 * Checks balances and deposits for a specific wallet
 */
async function checkWalletBalances(
    wallet: string,
    fastify: FastifyInstance
): Promise<void> {
    const { networkConfig, tokens } = fastify;
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);

    try {
        // Get ETH balance
        const ethBalance = await provider.getBalance(wallet);

        // Get token balances
        const tokenBalances = new Map<string, BigNumber>();
        await Promise.all(
            tokens
                .filter(token => token.chain_id === networkConfig.chain_id)
                .map(async (token) => {
                    const balance = await getTokenBalance(token.address, wallet, provider);
                    tokenBalances.set(token.symbol, balance);
                })
        );

        // Get last known balances or initialize with zeros
        const lastBalance = lastKnownBalances.get(wallet) || {
            eth: BigNumber.from(0),
            tokenBalances: new Map<string, BigNumber>()
        };

        // Create balance changes array
        const balanceChanges: TokenBalance[] = [
            {
                token: 'ETH',
                current: ethBalance,
                last: lastBalance.eth,
                formatter: ethers.utils.formatEther
            },
            ...Array.from(tokenBalances.entries()).map(([symbol, balance]) => ({
                token: symbol,
                current: balance,
                last: lastBalance.tokenBalances.get(symbol) || BigNumber.from(0),
                formatter: (val: BigNumber) => ethers.utils.formatUnits(val, 18)
            }))
        ];

        await processBalanceChanges(wallet, balanceChanges, fastify);

        // Update last known balances
        lastKnownBalances.set(wallet, {
            eth: ethBalance,
            tokenBalances
        });
    } catch (error) {
        console.error(`Error checking balance for ${wallet}:`, error);
    }
}

/**
 * Main function to check balances and deposits for all monitored wallets
 */
async function checkBalancesAndDeposits(fastify: FastifyInstance): Promise<void> {
    console.log('Checking balances and deposits...');
    await Promise.all(WALLETS_TO_MONITOR.map(wallet => checkWalletBalances(wallet, fastify)));
}

/**
 * Search for transactions in supported networks
 */
async function findApproximateDepositTransactions(
    wallet: string,
    depositAmount: BigNumber,
    fastify: FastifyInstance
): Promise<DepositTransaction[]> {
    const { networkConfig } = fastify;
    const scanConfig = getNetworkScanConfig(networkConfig.chain_id);
    
    return findApproximateDepositTransactionsOnNetwork(
        wallet,
        depositAmount,
        scanConfig
    );
}

/**
 * Search for deposit transactions in a specified network
 */
async function findApproximateDepositTransactionsOnNetwork(
    wallet: string,
    depositAmount: BigNumber,
    scanConfig: NetworkScanConfig
): Promise<DepositTransaction[]> {
    try {
        const response = await axios.get(scanConfig.apiUrl, {
            params: {
                module: 'account',
                action: 'txlist',
                address: wallet,
                startblock: 0,
                endblock: 99999999,
                sort: 'desc',
                apikey: scanConfig.apiKey,
            },
        });

        if (response.data.status === '1' && response.data.result.length > 0) {
            const oneHourAgo = Date.now() - 3600000;
            const relevantTxs = response.data.result
                .filter(
                    (tx: { to: string; timeStamp: string; value: string }) =>
                        tx.to.toLowerCase() === wallet.toLowerCase() &&
                        parseInt(tx.timeStamp, 10) * 1000 > oneHourAgo &&
                        BigNumber.from(tx.value).gt(0),
                )
                .map((tx: { hash: string; value: string }) => ({
                    hash: tx.hash,
                    value: BigNumber.from(tx.value),
                    url: `${scanConfig.explorer}/tx/${tx.hash}`,
                }));

            return relevantTxs.reduce(
                (matchingTxs: DepositTransaction[], tx: DepositTransaction) => {
                    const remainingAmount = depositAmount.sub(
                        matchingTxs.reduce((sum, mtx) => sum.add(mtx.value), BigNumber.from(0)),
                    );
                    
                    if (remainingAmount.lte(0)) return matchingTxs;

                    if (
                        tx.value.lte(remainingAmount) ||
                        (tx.value.gt(remainingAmount) &&
                            tx.value.lte(depositAmount.mul(110).div(100)))
                    ) {
                        return [...matchingTxs, tx];
                    }
                    return matchingTxs;
                },
                [],
            );
        }

        console.log(`No approximate deposit transactions found in the network.`);
        return [];
    } catch (error) {
        console.error('Error searching for deposit transactions:', error);
        return [];
    }
}

export {
    WalletBalance,
    DepositTransaction,
    checkBalancesAndDeposits,
    findApproximateDepositTransactions,
};