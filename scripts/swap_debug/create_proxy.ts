/* eslint-disable no-console */
import dotenv from 'dotenv';
import { ethers } from 'ethers';

// Cargar variables de entorno
dotenv.config();

/**
 * Script para crear un nuevo proxy directamente con el Factory
 * Sin usar Account Abstraction (sin UserOp ni Paymaster)
 */
async function createProxy(
    provider: ethers.providers.Provider,
    signer: ethers.Wallet,
    factoryAddress: string,
    ownerAddress: string
): Promise<string> {
    console.log('=====================================================');
    console.log('CREANDO NUEVO PROXY WALLET');
    console.log('=====================================================');

    // Factory ABI mínimo para crear proxy
    const factoryABI = [
        "function createProxy(address _owner) external returns (address)",
        "function computeProxyAddress(address _owner) external view returns (address)",
        "function getProxies() external view returns (address[])",
        "function owner() external view returns (address)"
    ];

    console.log(`\n1. Conectando al Factory: ${factoryAddress}`);
    const factory = new ethers.Contract(factoryAddress, factoryABI, signer);

    // Verificar que estamos autorizados (opcional)
    const factoryOwner = await factory.owner();
    console.log(`Factory owner: ${factoryOwner}`);
    console.log(`Transaction signer: ${signer.address}`);

    // Calcular la dirección del proxy antes de crearlo
    console.log(`\n2. Calculando dirección futura del proxy...`);
    try {
        const expectedAddress = await factory.computeProxyAddress(ownerAddress);
        console.log(`Dirección esperada del proxy: ${expectedAddress}`);
    } catch (error: unknown) {
        console.log(`No se pudo calcular la dirección futura: ${(error as Error).message}`);
    }

    // Obtener proxies existentes
    console.log(`\n3. Verificando proxies existentes...`);
    const existingProxies = await factory.getProxies();
    console.log(`Proxies existentes: ${existingProxies.length}`);

    // eslint-disable-next-line no-restricted-syntax
    for (const proxy of existingProxies) {
        console.log(`- ${proxy}`);
    }

    // Crear el proxy
    console.log(`\n4. Creando nuevo proxy con owner: ${ownerAddress}...`);

    try {
        console.log('Enviando transacción...');
        const tx = await factory.createProxy(ownerAddress, {
            gasLimit: 5000000, // Límite de gas suficiente
        });

        console.log(`Transacción enviada: ${tx.hash}`);
        console.log('Esperando confirmación...');

        const receipt = await tx.wait();
        console.log(`Transacción confirmada en el bloque: ${receipt.blockNumber}`);

        // Buscar el evento ProxyCreated en los logs
        const proxyAddress = findProxyAddressFromLogs(receipt.logs, ownerAddress);

        if (proxyAddress) {
            console.log(`\n¡ÉXITO! Nuevo proxy creado en: ${proxyAddress} ✅`);
            return proxyAddress;
        }

        // Obtener los proxies de nuevo para encontrar el nuevo
        const updatedProxies = await factory.getProxies();
        const newProxies = updatedProxies.filter((p: unknown) => !existingProxies.includes(p));

        if (newProxies.length > 0) {
            console.log(`\n¡ÉXITO! Nuevo proxy creado en: ${newProxies[0]} ✅`);
            return newProxies[0];
        }

        console.log(`\nNo se pudo identificar la dirección del nuevo proxy ❌`);
        return '';

    } catch (error: unknown) {
        console.error(`\nERROR al crear el proxy: ${(error as Error).message} ❌`);

        // Verificar si el error es de gas insuficiente
        if ((error as Error).message.includes('gas') || (error as Error).message.includes('insufficient funds')) {
            console.log('\nSugerencia: Podría ser un problema de gas. Verifica que tu wallet tenga suficiente ETH.');
        }

        return '';
    }
}

// Función para encontrar la dirección del proxy en los logs
function findProxyAddressFromLogs(logs: ethers.providers.Log[], ownerAddress: string): string {
    // El evento ProxyCreated tiene un formato similar a:
    // event ProxyCreated(address indexed owner, address indexed proxyAddress);

    return logs.reduce((result, log) => {
        // Si ya encontramos un resultado, lo mantenemos
        if (result) return result;

        // Intentamos identificar el evento por su estructura
        if (log.topics.length === 3) {
            // El primer topic es el hash del evento
            // El segundo topic debería ser el owner (indexado)
            // El tercer topic debería ser el proxy (indexado)

            // Convertir el address indexado a formato de dirección
            const topicOwner = `0x${log.topics[1].slice(26)}`;
            const topicProxy = `0x${log.topics[2].slice(26)}`;

            // Comparar con el owner que estamos buscando (caso insensitivo)
            if (topicOwner.toLowerCase() === ownerAddress.toLowerCase()) {
                return topicProxy;
            }
        }
        return result;
    }, '');
}

// Función principal
async function main() {
    try {
        // Obtener variables de entorno
        const RPC_URL = ('https://arbitrum-sepolia.infura.io/v3/INF_KEY').replace('INF_KEY', process.env.INFURA_API_KEY ?? '');
        const SIGNING_KEY = process.env.SIGNING_KEY || process.env.PRIVATE_KEY;
        const FACTORY_ADDRESS = "0xeCD34e3CB296Ed7c4a875290d49217f2C7cFf95b";

        // Verificar que tenemos las variables necesarias
        if (!RPC_URL) {
            console.error('ERROR: Falta RPC_URL en el archivo .env');
            process.exit(1);
        }

        if (!SIGNING_KEY) {
            console.error('ERROR: Falta SIGNING_KEY o PRIVATE_KEY en el archivo .env');
            process.exit(1);
        }

        if (!FACTORY_ADDRESS) {
            console.error('ERROR: Falta FACTORY_ADDRESS en el archivo .env');
            process.exit(1);
        }

        // Configurar provider y signer
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const signer = new ethers.Wallet(SIGNING_KEY, provider);

        console.log(`Ejecutando como: ${signer.address}`);

        // Por defecto, el owner del proxy será la misma dirección que firma la transacción
        const ownerAddress = process.env.OWNER_ADDRESS || signer.address;

        // Crear el proxy
        const proxyAddress = await createProxy(
            provider,
            signer,
            FACTORY_ADDRESS,
            ownerAddress
        );

        if (proxyAddress) {
            // Guardar la dirección del proxy para uso futuro
            console.log('\n=====================================================');
            console.log('INFORMACIÓN DEL NUEVO PROXY');
            console.log('=====================================================');
            console.log(`Dirección: ${proxyAddress}`);
            console.log(`Owner: ${ownerAddress}`);
            console.log(`Red: ${(await provider.getNetwork()).name} (${(await provider.getNetwork()).chainId})`);
            console.log('=====================================================');
            console.log('Agrega esta dirección a tu .env como PROXY_ADDRESS para usarla en otros scripts');

            process.exit(0);
        } else {
            process.exit(1);
        }
    } catch (error) {
        console.error('Error fatal durante la ejecución:', error);
        process.exit(1);
    }
}

// Ejecutar el script
main();