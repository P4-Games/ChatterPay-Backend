import { Signer } from 'ethers-5';
import { LiFi, RouteOptions, RoutesRequest } from '@lifi/sdk';

import { LIFI_TYPE, LIFI_SLIPPAGE } from '../constants/blockchain';

/**
 * Performs a token swap from USDC to WETH using the LiFi SDK.
 *
 * @param {Signer} signer - The ethers Signer object to execute the transaction.
 * @param {string} amount - The amount of USDC to swap, as a string.
 * @returns {Promise<string>} A promise that resolves to a status message:
 *                            "Swapped successfully to WETH" on success,
 *                            or "Error at swap" on failure.
 *
 * @description
 * This function sets up a LiFi instance, configures the route options,
 * and creates a route request to swap USDC to WETH on the Polygon network (chain ID 137).
 * It then executes the swap using the first route returned by LiFi.
 *
 * The function uses predefined SLIPPAGE and TYPE constants from LiFiConfig.
 *
 * @throws Will throw an error if there's an issue with the LiFi SDK or the blockchain transaction.
 */
export const swapToWETH = async (signer: Signer, amount: string): Promise<string> => {
  // Initialize LiFi SDK
  const lifi = new LiFi({
    integrator: 'tdm.ar'
  });

  // Configure route options
  const routeOptions: RouteOptions = {
    slippage: LIFI_SLIPPAGE,
    order: LIFI_TYPE
  };

  // Set up the route request for USDC to WETH swap
  const routesRequest: RoutesRequest = {
    fromChainId: 137, // Polygon network
    fromAmount: amount,
    fromTokenAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC on Polygon
    toChainId: 137, // Staying on Polygon
    toTokenAddress: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH on Polygon
    options: routeOptions
  };

  console.log('**Routes Request**');
  console.log(routesRequest);

  // Get routes from LiFi
  const lifiResult = await lifi.getRoutes(routesRequest);
  const chosenRoute = lifiResult.routes[0];

  // Execute the swap
  const makeTrade = async () =>
    new Promise((resolve) => {
      lifi
        .executeRoute(signer, chosenRoute, {
          acceptExchangeRateUpdateHook: (exchangeRate) => {
            console.log('**Exchange Rate**');
            console.log(exchangeRate);
            return Promise.resolve(true);
          }
        })
        .then((lifiTx) => {
          console.log(lifiTx);
          // TODO: Log trade in database, logTrade((parseInt(amount) / 1e6), lifiTx.id, true)
          resolve(true);
        });
    }).catch(() => false);

  const status = await makeTrade();

  // Return status message based on swap result
  return status ? 'Swapped successfully to WETH' : 'Error at swap';
};
