import Fastify from 'fastify';
import { ethers } from 'ethers';

const fastify = Fastify({
    logger: true
});

const SEPOLIA_RPC_URL = 'https://sepolia.infura.io/v3/' + process.env.INFURA_API_KEY; // Reemplaza con tu URL de Infura

const provider = new ethers.providers.JsonRpcProvider(SEPOLIA_RPC_URL);

// Array de wallets que queremos monitorear
const WALLETS_TO_MONITOR = [
    '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    '0x123456789abcdef123456789abcdef123456789a',
    // Añade más direcciones según sea necesario
];

// Direcciones de los contratos de tokens (ejemplo)
const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// ABI mínimo para obtener el balance y decimales de un token ERC20
const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

// Mapa para almacenar los últimos balances conocidos
const lastKnownBalances = new Map<string, { eth: ethers.BigNumber, usdt: ethers.BigNumber, usdc: ethers.BigNumber }>();

fastify.get('/', async (request, reply) => {
    return { hello: 'world' };
});

const startServer = async () => {
    try {
        await fastify.listen({ port: 3000 });
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

const getTokenBalance = async (tokenAddress: string, walletAddress: string) => {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const balance = await contract.balanceOf(walletAddress);
    const decimals = await contract.decimals();
    return ethers.utils.formatUnits(balance, decimals);
};

const checkBalancesAndDeposits = async () => {
    console.log('Verificando balances y depósitos...');
    for (const wallet of WALLETS_TO_MONITOR) {
        try {
            const ethBalance = await provider.getBalance(wallet);
            const usdtBalance = ethers.BigNumber.from(await getTokenBalance(USDT_ADDRESS, wallet));
            const usdcBalance = ethers.BigNumber.from(await getTokenBalance(USDC_ADDRESS, wallet));

            const lastBalance = lastKnownBalances.get(wallet) || { eth: ethers.BigNumber.from(0), usdt: ethers.BigNumber.from(0), usdc: ethers.BigNumber.from(0) };

            // Verificar depósitos de ETH
            if (ethBalance.gt(ethers.BigNumber.from(lastBalance.eth))) {
                const deposit = ethBalance.sub(lastBalance.eth);
                const block = await provider.getBlock('latest');
                const transactions = await Promise.all(
                    block.transactions.map(txHash => provider.getTransaction(txHash))
                );
                const depositTx = transactions.find(tx => tx.to?.toLowerCase() === wallet.toLowerCase());

                if (depositTx) {
                    console.log(`Depositaste ${ethers.utils.formatEther(deposit)} ETH - Nuevo balance: ${ethers.utils.formatEther(ethBalance)} ETH`);
                    console.log(`Hash de la transacción: ${depositTx.hash}`);
                }
            }

            // Verificar depósitos de USDT
            if (usdtBalance.gt(lastBalance.usdt)) {
                const deposit = usdtBalance.sub(lastBalance.usdt);
                console.log(`Depositaste ${deposit} USDT - Nuevo balance: ${usdtBalance} USDT`);
                // Aquí podrías buscar la transacción específica del token si es necesario
            }

            // Verificar depósitos de USDC
            if (usdcBalance.gt(lastBalance.usdc)) {
                const deposit = usdcBalance.sub(lastBalance.usdc);
                console.log(`Depositaste ${deposit} USDC - Nuevo balance: ${usdcBalance} USDC`);
                // Aquí podrías buscar la transacción específica del token si es necesario
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
};

const startMonitoring = () => {
    // Verificar balances inmediatamente al iniciar
    checkBalancesAndDeposits();

    // Configurar el intervalo para verificar cada 30 minutos
    setInterval(checkBalancesAndDeposits, 30 * 60 * 1000);
};

startServer();
startMonitoring();