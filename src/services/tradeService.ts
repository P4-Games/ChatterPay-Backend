import { Signer } from "ethers-5";
import { LiFi, RouteOptions, RoutesRequest } from "@lifi/sdk";

import { TYPE, SLIPPAGE } from "../constants/LiFiConfig";

export const swapToWETH = async (signer: Signer, amount: string): Promise<string> => {
    const lifi = new LiFi({
        integrator: 'tdm.ar'
    })

    const routeOptions: RouteOptions = {
        slippage: SLIPPAGE,
        order: TYPE
    }

    // do a swap from WETH to USDC (swapBalance + amount)
    const routesRequest: RoutesRequest = {
        fromChainId: 137,
        fromAmount: amount, // x USDC
        fromTokenAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC
        toChainId: 137,
        toTokenAddress: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH
        options: routeOptions,
    }

    console.log('**Routes Request**');
    console.log(routesRequest)

    const lifiResult = await lifi.getRoutes(routesRequest)
    const chosenRoute = lifiResult.routes[0];

    const makeTrade = async () => new Promise((resolve) => {
            lifi.executeRoute(signer, chosenRoute, {
                acceptExchangeRateUpdateHook: (exchangeRate) => {
                    console.log('**Exchange Rate**');
                    console.log(exchangeRate);
                    return Promise.resolve(true);
                },
            }).then((lifiTx) => {
                console.log(lifiTx)
                // TODO: Log trade in database, logTrade((parseInt(amount) / 1e6), lifiTx.id, true)
                resolve(true);
            })
        }).catch(() => false)

    const status = await makeTrade();

    if (!status) {
        return "Error at swap";
    }

    return "Swapped successfully to WETH";
}
