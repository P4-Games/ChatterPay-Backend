import { BigNumber, ethers } from 'ethers';
import axios from 'axios';

/** URLs y API Keys de los escaners */
const SCROLL_TESTNET_API = 'https://api-sepolia.scrollscan.com/api';
const SEPOLIA_API = 'https://api-sepolia.etherscan.io/api';
const SCROLL_API_KEY = process.env?.SCROLLSCAN_API_KEY ?? "";
const SEPOLIA_API_KEY = process.env?.ETHERSCAN_API_KEY ?? "";

/** Dirección de los contratos */
const USDT_ADDRESS = 'DIRECCION_DEL_CONTRATO_USDT';
const USDC_ADDRESS = 'DIRECCION_DEL_CONTRATO_USDC';

/** Array de direcciones de billeteras a monitorear */
const WALLETS_TO_MONITOR: string[] = ['WALLET1', 'WALLET2', 'WALLET3'];

/** Proveedor de Ethereum */
const provider: ethers.providers.Provider = new ethers.providers.JsonRpcProvider('URL_DEL_PROVEEDOR');

/** Representa los balances de una billetera */
interface WalletBalance {
    eth: BigNumber;
    usdt: BigNumber;
    usdc: BigNumber;
}

/** Mapa para almacenar los últimos balances conocidos de las billeteras */
const lastKnownBalances: Map<string, WalletBalance> = new Map();

/** Representa una transacción de depósito */
interface DepositTransaction {
    hash: string;
    value: BigNumber;
    url: string;
}

/**
 * Obtiene el balance de un token ERC20 para una dirección dada
 * @param tokenAddress - La dirección del contrato del token
 * @param walletAddress - La dirección de la billetera
 * @returns El balance del token como BigNumber
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
 * Verifica los balances y depósitos para todas las billeteras monitoreadas
 */
async function checkBalancesAndDeposits(): Promise<void> {
    console.log('Verificando balances y depósitos...');

    for (const wallet of WALLETS_TO_MONITOR) {
        try {
            const ethBalance = await provider.getBalance(wallet);
            const usdtBalance = await getTokenBalance(USDT_ADDRESS, wallet);
            const usdcBalance = await getTokenBalance(USDC_ADDRESS, wallet);

            const lastBalance = lastKnownBalances.get(wallet) || { 
                eth: BigNumber.from(0), 
                usdt: BigNumber.from(0), 
                usdc: BigNumber.from(0) 
            };

            // Verificar depósitos de ETH
            if (ethBalance.gt(lastBalance.eth)) {
                const deposit = ethBalance.sub(lastBalance.eth);
                const depositTxs = await findApproximateDepositTransactions(wallet, deposit);

                if (depositTxs.length > 0) {
                    console.log(`Detectado cambio en balance de ETH - Nuevo balance: ${ethers.utils.formatEther(ethBalance)} ETH`);
                    console.log(`Depósitos aproximados encontrados:`);
                    depositTxs.forEach(tx => {
                        console.log(`- ${ethers.utils.formatEther(tx.value)} ETH`);
                        console.log(`  Hash: ${tx.hash}`);
                        console.log(`  URL: ${tx.url}`);
                    });
                }
            }

            // Verificar depósitos de USDT
            if (usdtBalance.gt(lastBalance.usdt)) {
                const deposit = usdtBalance.sub(lastBalance.usdt);
                console.log(`Detectado cambio en balance de USDT - Nuevo balance: ${ethers.utils.formatUnits(usdtBalance, 6)} USDT`);
                // Implementar búsqueda de transacción para tokens si es necesario
            }

            // Verificar depósitos de USDC
            if (usdcBalance.gt(lastBalance.usdc)) {
                const deposit = usdcBalance.sub(lastBalance.usdc);
                console.log(`Detectado cambio en balance de USDC - Nuevo balance: ${ethers.utils.formatUnits(usdcBalance, 6)} USDC`);
                // Implementar búsqueda de transacción para tokens si es necesario
            }

            lastKnownBalances.set(wallet, { 
                eth: ethBalance, 
                usdt: usdtBalance, 
                usdc: usdcBalance 
            });

        } catch (error) {
            console.error(`Error al verificar el balance de ${wallet}:`, error);
        }
    }
}

/**
 * Busca transacciones de depósito aproximadas en ambas redes
 * @param wallet - Dirección de la billetera
 * @param depositAmount - Monto del depósito
 * @returns Array de transacciones de depósito aproximadas
 */
async function findApproximateDepositTransactions(wallet: string, depositAmount: BigNumber): Promise<DepositTransaction[]> {
    let depositTxs = await findApproximateDepositTransactionsOnNetwork(wallet, depositAmount, SCROLL_TESTNET_API, SCROLL_API_KEY);
    if (depositTxs.length === 0) {
        depositTxs = await findApproximateDepositTransactionsOnNetwork(wallet, depositAmount, SEPOLIA_API, SEPOLIA_API_KEY);
    }
    return depositTxs;
}

/**
 * Busca transacciones de depósito aproximadas en una red específica
 * @param wallet - Dirección de la billetera
 * @param depositAmount - Monto del depósito
 * @param apiUrl - URL de la API de la red
 * @param apiKey - Clave API para la red
 * @returns Array de transacciones de depósito aproximadas
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
                .filter((tx: any) => 
                    tx.to.toLowerCase() === wallet.toLowerCase() &&
                    parseInt(tx.timeStamp) * 1000 > oneHourAgo &&
                    BigNumber.from(tx.value).gt(0)
                )
                .map((tx: any) => ({
                    hash: tx.hash,
                    value: BigNumber.from(tx.value),
                    url: apiUrl.includes('scrollscan') 
                        ? `https://sepolia.scrollscan.com/tx/${tx.hash}`
                        : `https://sepolia.etherscan.io/tx/${tx.hash}`
                }));

            let remainingAmount = depositAmount;
            const matchingTxs: DepositTransaction[] = [];

            for (const tx of relevantTxs) {
                if (remainingAmount.lte(0)) break;

                if (tx.value.lte(remainingAmount)) {
                    matchingTxs.push(tx);
                    remainingAmount = remainingAmount.sub(tx.value);
                } else if (tx.value.gt(remainingAmount) && tx.value.lte(depositAmount.mul(110).div(100))) {
                    // Permitimos hasta un 10% de diferencia para manejar posibles discrepancias
                    matchingTxs.push(tx);
                    break;
                }
            }

            return matchingTxs;
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
    checkBalancesAndDeposits, 
    findApproximateDepositTransactions, 
    WalletBalance, 
    DepositTransaction 
};