/* eslint-disable no-console */
import dotenv from 'dotenv';
import { ethers } from 'ethers';

// Cargar variables de entorno
dotenv.config();

/**
 * Script completo para validar todas las condiciones necesarias antes de un swap
 * Ejecuta este script antes de intentar el swap para diagnosticar problemas
 */
async function validateSwapPrerequisites(
    provider: ethers.providers.Provider,
    chatterPayAddress: string,
    proxyAddress: string,
    tokenIn: string,
    tokenOut: string,
    amount: string,
    recipient: string
): Promise<boolean> {
    console.log('=====================================================');
    console.log('VALIDACIÓN COMPLETA PRE-SWAP');
    console.log('=====================================================');

    try {
        // 1. Cargar ABIs necesarios
        console.log('1. Cargando ABIs y contratos...');

        // ChatterPay ABI simplificado con las funciones necesarias
        const chatterPayABI = [
            "function isTokenWhitelisted(address) view returns (bool)",
            "function getPriceFeed(address) view returns (address)",
            "function getSwapRouter() view returns (address)",
            "function getFeeInCents() view returns (uint256)",
            "function owner() view returns (address)"
        ];

        // ERC20 ABI simplificado
        const erc20ABI = [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)",
            "function allowance(address,address) view returns (uint256)"
        ];

        // Uniswap Factory ABI simplificado
        const uniswapFactoryABI = [
            "function getPool(address,address,uint24) view returns (address)"
        ];

        // Uniswap Pool ABI simplificado
        const uniswapPoolABI = [
            "function liquidity() view returns (uint128)",
            "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
        ];

        // Chainlink ABI simplificado
        const chainlinkABI = [
            "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
            "function decimals() view returns (uint8)"
        ];

        // Inicializar contratos
        const chatterPay = new ethers.Contract(chatterPayAddress, chatterPayABI, provider);
        const tokenInContract = new ethers.Contract(tokenIn, erc20ABI, provider);
        const tokenOutContract = new ethers.Contract(tokenOut, erc20ABI, provider);

        console.log(`ChatterPay: ${chatterPayAddress}`);
        console.log(`Proxy: ${proxyAddress}`);
        console.log(`TokenIn: ${tokenIn}`);
        console.log(`TokenOut: ${tokenOut}`);
        console.log('Contratos cargados correctamente ✅');

        // 2. Verificar whitelist de tokens
        console.log('\n2. Verificando estado de whitelist...');
        const [inWhitelisted, outWhitelisted] = await Promise.all([
            chatterPay.isTokenWhitelisted(tokenIn),
            chatterPay.isTokenWhitelisted(tokenOut)
        ]);

        console.log(`TokenIn whitelisted: ${inWhitelisted ? '✅' : '❌'}`);
        console.log(`TokenOut whitelisted: ${outWhitelisted ? '✅' : '❌'}`);

        if (!inWhitelisted || !outWhitelisted) {
            console.log('ERROR: Ambos tokens deben estar en la whitelist');
            return false;
        }

        // 3. Obtener información de los tokens
        console.log('\n3. Obteniendo información de tokens...');
        const [
            tokenInSymbol,
            tokenInDecimals,
            tokenOutSymbol,
            tokenOutDecimals
        ] = await Promise.all([
            tokenInContract.symbol(),
            tokenInContract.decimals(),
            tokenOutContract.symbol(),
            tokenOutContract.decimals()
        ]);

        console.log(`TokenIn: ${tokenInSymbol} (${tokenInDecimals} decimales)`);
        console.log(`TokenOut: ${tokenOutSymbol} (${tokenOutDecimals} decimales)`);

        // 4. Verificar balances
        console.log('\n4. Verificando balances...');
        const amountInBN = ethers.utils.parseUnits(amount, tokenInDecimals);
        const balance = await tokenInContract.balanceOf(proxyAddress);

        console.log(`Balance requerido: ${ethers.utils.formatUnits(amountInBN, tokenInDecimals)} ${tokenInSymbol}`);
        console.log(`Balance actual: ${ethers.utils.formatUnits(balance, tokenInDecimals)} ${tokenInSymbol}`);

        if (balance.lt(amountInBN)) {
            console.log('ERROR: Balance insuficiente ❌');
            return false;
        }
        console.log('Balance suficiente ✅');

        // 5. Verificar price feeds
        console.log('\n5. Verificando price feeds...');
        const [inPriceFeed, outPriceFeed] = await Promise.all([
            chatterPay.getPriceFeed(tokenIn),
            chatterPay.getPriceFeed(tokenOut)
        ]);

        console.log(`TokenIn price feed: ${inPriceFeed}`);
        console.log(`TokenOut price feed: ${outPriceFeed}`);

        if (inPriceFeed === ethers.constants.AddressZero || outPriceFeed === ethers.constants.AddressZero) {
            console.log('ERROR: Algún price feed no está configurado ❌');
            return false;
        }

        // 6. Verificar precios actuales
        console.log('\n6. Verificando precios...');
        try {
            const inPriceFeedContract = new ethers.Contract(inPriceFeed, chainlinkABI, provider);
            const outPriceFeedContract = new ethers.Contract(outPriceFeed, chainlinkABI, provider);

            const [inRoundData, outRoundData] = await Promise.all([
                inPriceFeedContract.latestRoundData(),
                outPriceFeedContract.latestRoundData()
            ]);

            const inPrice = inRoundData.answer;
            const outPrice = outRoundData.answer;

            console.log(`Precio de ${tokenInSymbol}: ${inPrice.toString()}`);
            console.log(`Precio de ${tokenOutSymbol}: ${outPrice.toString()}`);

            if (inPrice.lte(0) || outPrice.lte(0)) {
                console.log('ERROR: Precios inválidos ❌');
                return false;
            }
        } catch (error: unknown) {
            console.log(`ERROR al obtener precios: ${(error as Error).message} ❌`);
            return false;
        }

        // 7. Obtener router de Uniswap
        console.log('\n7. Verificando router...');
        const router = await chatterPay.getSwapRouter();
        console.log(`Router address: ${router}`);

        if (router === ethers.constants.AddressZero) {
            console.log('ERROR: Router no configurado ❌');
            return false;
        }

        // 8. Verificar allowance
        console.log('\n8. Verificando allowance...');
        const allowance = await tokenInContract.allowance(proxyAddress, router);
        console.log(`Allowance actual: ${ethers.utils.formatUnits(allowance, tokenInDecimals)} ${tokenInSymbol}`);

        if (allowance.lt(amountInBN)) {
            console.log('ADVERTENCIA: Allowance insuficiente ⚠️');
            console.log('Es necesario aprobar tokens antes del swap');
        } else {
            console.log('Allowance suficiente ✅');
        }

        // 9. Verificar pool y liquidez
        console.log('\n9. Verificando pool y liquidez...');

        // Determinar la factory de Uniswap según el router
        // Esto es una aproximación - idealemnte deberías tener la dirección correcta de la factory
        let uniswapFactoryAddress;

        // Detectar factory basado en la red
        if (await provider.getNetwork().then(n => n.chainId) === 421614) { // Arbitrum
            uniswapFactoryAddress = "0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e"; // Arbitrum Sepolia factory
        } else {
            // Dirección genérica de Uniswap v3 factory (mainnet)
            uniswapFactoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
        }

        try {
            const uniswapFactory = new ethers.Contract(uniswapFactoryAddress, uniswapFactoryABI, provider);

            // Probar diferentes fee tiers
            const feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%
            let poolAddress = ethers.constants.AddressZero;
            let feeTier = 0;

            const pools = await Promise.all(
                feeTiers.map(fee => uniswapFactory.getPool(tokenIn, tokenOut, fee))
            );
            const poolIndex = pools.findIndex(pool => pool !== ethers.constants.AddressZero);
            if (poolIndex >= 0) {
                poolAddress = pools[poolIndex];
                feeTier = feeTiers[poolIndex];
            }

            if (poolAddress === ethers.constants.AddressZero) {
                console.log('ERROR: No se encontró ningún pool para este par de tokens ❌');
                console.log('Es necesario crear un pool antes de poder hacer swaps');
                return false;
            }

            console.log(`Pool encontrado: ${poolAddress} (fee: ${feeTier / 10000}%)`);

            // Verificar liquidez
            const pool = new ethers.Contract(poolAddress, uniswapPoolABI, provider);
            const liquidity = await pool.liquidity();
            console.log(`Liquidez actual: ${liquidity.toString()}`);

            if (liquidity.eq(0)) {
                console.log('ERROR: El pool no tiene liquidez ❌');
                return false;
            }

            // Obtener el precio actual en el pool
            const slot0 = await pool.slot0();
            console.log(`Precio sqrt actual: ${slot0.sqrtPriceX96.toString()}`);
            console.log(`Tick actual: ${slot0.tick}`);

        } catch (error: unknown) {
            console.log(`ERROR al verificar pool: ${(error as Error).message} ❌`);
            return false;
        }

        // 10. Verificar fee settings
        console.log('\n10. Verificando configuración de fee...');
        const feeInCents = await chatterPay.getFeeInCents();
        console.log(`Fee actual: ${feeInCents.toString()} cents`);

        // 11. Verificar propietario del wallet
        console.log('\n11. Verificando propietario del wallet...');
        const owner = await chatterPay.owner();
        console.log(`Owner: ${owner}`);

        // Resumir resultados
        console.log('\n=====================================================');
        console.log('RESUMEN DE VALIDACIÓN');
        console.log('=====================================================');
        console.log(`ChatterPay: ${chatterPayAddress}`);
        console.log(`Proxy: ${proxyAddress}`);
        console.log(`TokenIn: ${tokenInSymbol} (${tokenIn})`);
        console.log(`TokenOut: ${tokenOutSymbol} (${tokenOut})`);
        console.log(`Amount: ${amount} ${tokenInSymbol}`);
        console.log(`Recipient: ${recipient}`);
        console.log(`Whitelist TokenIn: ${inWhitelisted ? '✅' : '❌'}`);
        console.log(`Whitelist TokenOut: ${outWhitelisted ? '✅' : '❌'}`);
        console.log(`Balance suficiente: ${balance.gte(amountInBN) ? '✅' : '❌'}`);
        console.log(`Allowance suficiente: ${allowance.gte(amountInBN) ? '✅' : '❌'}`);
        console.log('Pool con liquidez: ✅');
        console.log('=====================================================');

        return true;
    } catch (error) {
        console.error('Error durante la validación:', error);
        return false;
    }
}

// Función principal
async function main() {
    try {
        // Obtener variables de entorno o usar valores predeterminados
        const rpcUrl = ('https://arbitrum-sepolia.infura.io/v3/INF_KEY').replace('INF_KEY', process.env.INFURA_KEY ?? '');

        // Obtener parámetros del archivo .env o usar valores predeterminados
        const CHATTERPAY_ADDRESS = '0xBc5a2FE45C825BB091075664cae88914FB3f73f0';
        const PROXY_ADDRESS = '0x0A13B7765507995f0854682a31E45cAAf6E9e4bd';
        const TOKEN_IN = '0xe6B817E31421929403040c3e42A6a5C5D2958b4A'; // USDT
        const TOKEN_OUT = '0xE9C723D01393a437bac13CE8f925A5bc8E1c335c'; // WETH
        const AMOUNT = '10';
        const RECIPIENT = '0xe54b48F8caF88a08849dCdDE3D3d41Cd6D7ab369';

        // Configurar el proveedor
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

        // Ejecutar la validación
        console.log('Iniciando validación de swap...');
        const result = await validateSwapPrerequisites(
            provider,
            CHATTERPAY_ADDRESS,
            PROXY_ADDRESS,
            TOKEN_IN,
            TOKEN_OUT,
            AMOUNT,
            RECIPIENT
        );

        console.log(`\nValidación ${result ? 'exitosa ✅' : 'fallida ❌'}`);

        process.exit(result ? 0 : 1);
    } catch (error) {
        console.error('Error fatal durante la ejecución:', error);
        process.exit(1);
    }
}

// Ejecutar el script
main();