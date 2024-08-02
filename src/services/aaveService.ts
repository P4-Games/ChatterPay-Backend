import { ASSETS, CONTRACT_ADDRESS, providerRPC } from "../constants/aave";
import dotenv from "dotenv";
import { getPriceByEVMContract } from "./priceService";
import { ethers } from "ethers";
import ABI from "../../aaveABI.json";
import { FastifyReply, FastifyRequest } from "fastify";

dotenv.config({path: './.env'});

/**
 * Funcion para pedir prestado en AAVE
 * @param amount Monto a pedir prestado en numeros, sin agregar decimales
 * @param address Direccion del token
 * @param token Nombre del token
 */
export const borrow = async (amount: number, tokenAddress: string, tokenName: string) => {
    const provider = new ethers.providers.JsonRpcProvider(providerRPC.mumbai.rpc,
        {
            name: "Sepolia",
            chainId: 11155111,
        }
    );

    const signer = new ethers.Wallet(process.env.SIGNING_KEY ?? "", provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

    const etherPrice = await getPriceByEVMContract([
        ["eth", ASSETS["eth"]]
    ]);

    const borrowAmount = Math.floor((amount / parseInt(etherPrice[0][1].toString())) * 1e18).toString();
    const args = [
        ASSETS[tokenName.toLowerCase()],
        borrowAmount,
        '2',
        '0',
        tokenAddress,
    ];

    console.log(JSON.stringify(args))

    try{
        const createReceipt = await contract.borrow(...args);
        await createReceipt.wait();
        console.log("Borrowed ", amount, createReceipt.hash);
        //logBorrows(parseInt((amount).toString()) / (token === "usdc" ? 1e6 : 1e18), createReceipt.hash, address);
    } catch (e) {
        console.log(e);
    }
}

/**
 * Funcion para depositar en AAVE
 * @param amount Monto a depositar en numeros, sin agregar decimales
 * @param address Direccion del token
 */
export const supply =  async (request: FastifyRequest<{ Body: { tokenAddress: string, amount: number } }>, reply: FastifyReply) => {
    const {tokenAddress, amount} = request.body;
    const provider = new ethers.providers.JsonRpcProvider(providerRPC.mumbai.rpc,
        {
            name: "Sepolia",
            chainId: 11155111,
        }
    );

    const signer = new ethers.Wallet(process.env.SIGNING_KEY ?? "", provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

    const etherPrice = await getPriceByEVMContract([
        ["eth", ASSETS["eth"]]
    ]);

    const supplyAmount = Math.floor((amount / parseInt(etherPrice[0][1].toString())) * 1e18).toString();
    const args = [
        tokenAddress,
        supplyAmount,
        '0',
        '0',
        CONTRACT_ADDRESS,
    ];

    console.log(JSON.stringify(args))

    try{
        const createReceipt = await contract.supply(...args);
        await createReceipt.wait();
        console.log("Supplied ", amount, createReceipt.hash);
        //logSupplies(amountToRegister, createReceipt.hash, address);
    } catch (e) {
        console.log(e);
    }
}

/**
 * Obtener el yield actual en AAVE para la red especificada
 * @param tokenAddress Direccion del token
 */

type AAVEToken = {
    underlyingAsset: string,
    symbol: string,
    isActive: boolean,
    isFreezed: boolean,
    borrowingEnabled: boolean,
    stableBorrowRateEnabled: boolean,
    variableBorrowRate: string,
    stableBorrowRate: string,
    liquidityRate: string,
    totalLiquidity: string,
    lastUpdateTimestamp: number,
    aTokenAddress: string,
    totalBorrows: string,
    id: string,
    totalLiquidityUSD: string,
    totalBorrowsUSD: string,
    interestPerSecond: string,
}

type AAVEPayload = {
    reserves: AAVEToken[]
}

export const getAAVEYield = async (request: FastifyRequest<{ Params: { address: string } }>, reply: FastifyReply) => {
    const { address } = request.params as { address: string };

    const URL = "https://aave-api-v2.aave.com/data/markets-data";

    const priceRequest = await fetch(URL);

    const data: AAVEPayload = await priceRequest.json();

    const tokenData = data.reserves.find((token: any) => token.underlyingAsset === address);

    const APY = tokenData ? Math.round(parseFloat(tokenData.liquidityRate) * 1e2) / 1e2 : 0;
    
    return APY;
}

