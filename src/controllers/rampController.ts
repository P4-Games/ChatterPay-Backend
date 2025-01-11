import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { returnSuccessResponse } from '../helpers/requestHelper';

/**
 * Controller for creating a new user.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const createRampUser = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('createUser', 'Creating a new user in Manteca');
  return returnSuccessResponse(reply, 'User created successfully');
};

/**
 * Controller to upload user documents.
 * First, it fetches the upload URL and then uploads the document as binary.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const uploadRampUserDocuments = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('userUploadDocuments', 'Fetching upload URL for documents');

  // Mocking the upload URL response
  const uploadUrl = 'https://upload.manteca.dev/file-upload-url';

  Logger.log('userUploadDocuments', `Uploading document to URL: ${uploadUrl}`);
  return returnSuccessResponse(reply, 'Document uploaded successfully');
};

/**
 * Controller for getting account validation status.
 * Returns a boolean indicating whether the user is validated.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const getUserRampValidationStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  const { userId } = request.params as { userId: string }; // Explicitly cast the params type
  Logger.log('getUserValidationStatus', `Getting validation status for user ID: ${userId}`);

  // Mocking the validation status response
  const isValidated = true;

  return returnSuccessResponse(reply, `${isValidated}`);
};

/**
 * Controller for getting user limits.
 * Returns monthly and yearly limits based on the user's economic level.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const getUserRampLimits = async (request: FastifyRequest, reply: FastifyReply) => {
  const { userId } = request.params as { userId: string }; // Explicitly cast the params type
  Logger.log('getUserLimits', `Getting limits for user ID: ${userId}`);

  // Mocking the user's limits response
  const limits = {
    economicLevel: 4,
    totalOperated: 20000,
    monthLeft: 560000,
    yearLeft: 760000,
    monthLimit: 560000,
    yearLimit: 760000
  };

  return returnSuccessResponse(reply, 'user limits', limits);
};

/**
 * Controller for getting user balance.
 * Returns current balance and locked funds.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const getUserRampBalance = async (request: FastifyRequest, reply: FastifyReply) => {
  const { userId } = request.params as { userId: string }; // Explicitly cast the params type
  Logger.log('getUserBalance', `Getting balance for user ID: ${userId}`);

  // Mocking the user's balance response
  const balance = {
    fiat: {
      ARS: { amount: '973800.00' }
    },
    crypto: {
      WLD: { amount: '3.0', weiAmount: '3000000000000000000' },
      USDC: { amount: '7.0', weiAmount: '7000000000000000000' }
    },
    locked: {
      fiat: {
        ARS: { amount: '1000.00' }
      },
      crypto: {}
    }
  };
  return returnSuccessResponse(reply, 'user balance', balance);
};

/**
 * Controller for getting prices of currency pairs.
 * Returns the buy and sell prices for pairs such as BTC_ARS, BTC_USD, etc.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const getCryptoPairPrices = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('getCryptoPairPrices', 'Fetching prices for currency pairs');

  // Mocking the response for crypto pair prices
  const prices = {
    BTC_ARS: {
      coin: 'BTC_ARS',
      timestamp: '1701873973358',
      buy: '40214902',
      sell: '38447214',
      variation: {
        realtime: '0.000',
        daily: '4.663'
      }
    },
    BTC_USD: {
      coin: 'BTC_USD',
      timestamp: '1701873973358',
      buy: '47285.65',
      sell: '40656.824',
      variation: {
        realtime: '0.000',
        daily: '4.663'
      }
    }
  };

  return returnSuccessResponse(reply, 'prices', prices);
};

/**
 * Controller for Ramp-On synthetic operation
 * Simulates a synthetic "Ramp-On" process for asset exchange.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const rampOn = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('rampOn', 'Simulating Ramp-On process');

  // Mocking response for Ramp-On synthetic operation
  const rampOnResponse = {
    id: '675c39a4ca5811051b7ec211',
    externalId: 'externalId-synth-001',
    numberId: '55',
    companyId: '61ba38ec7dd2e73960392a6d',
    userId: '6723ddca878dc74ee55d933a',
    userNumberId: '100004336',
    userExternalId: 'user-identifier',
    status: 'STARTING',
    type: 'RAMP_OPERATION',
    details: {
      depositAddress: '0000633600000000000123',
      withdrawCostInAgainst: '816.41',
      withdrawCostInAsset: '0.706849'
    },
    currentStage: 1,
    stages: {
      1: {
        stageType: 'DEPOSIT',
        asset: 'ARS',
        tresholdAmount: '1155000.00',
        useOverflow: true,
        expireAt: '2024-12-13T15:41:56.399Z'
      },
      2: {
        stageType: 'ORDER',
        side: 'BUY',
        type: 'MARKET',
        asset: 'USDC',
        against: 'ARS',
        assetAmount: '1000',
        price: '1155.00',
        priceCode: '65f45975-3b6c-4c5a-a8a7-efb420f208f7',
        disallowDebt: true
      },
      3: {
        stageType: 'WITHDRAW',
        network: 'BASE',
        asset: 'USDC',
        amount: '1000',
        to: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
      }
    },
    creationTime: '2024-12-13T10:41:56.513-03:00',
    updatedAt: '2024-12-13T10:41:56.513-03:00'
  };

  return returnSuccessResponse(reply, 'ramp-on', rampOnResponse);
};

/**
 * Controller for Ramp-Off synthetic operation
 * Simulates a synthetic "Ramp-Off" process for asset exchange.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const rampOff = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('rampOff', 'Simulating Ramp-Off process');

  // Mocking response for Ramp-Off synthetic operation
  const rampOffResponse = {
    id: '675c4dfb7a7c317162a06bd3',
    numberId: '61',
    externalId: 'externalId-synth-ramp-off-12',
    companyId: '61ba38ec7dd2e73960392a6d',
    userId: '6723e1e8878dc74ee55d93c2',
    userNumberId: '100004338',
    userExternalId: 'external-id-1',
    sessionId: 'sessionId-test-synth-1',
    status: 'STARTING',
    type: 'RAMP_OPERATION',
    details: {
      depositAddress: '0x701d632075ffe6D70D06bD390C979Ad7EB16Dc61',
      depositAvailableNetworks: [
        'ETHEREUM',
        'BINANCE',
        'POLYGON',
        'OPTIMISM',
        'BASE',
        'ARBITRUM',
        'INTERNAL'
      ],
      withdrawCostInAgainst: '0',
      withdrawCostInAsset: '0'
    },
    currentStage: 1,
    stages: {
      1: {
        stageType: 'DEPOSIT',
        asset: 'USDC',
        tresholdAmount: '10.51900785',
        useOverflow: true,
        expireAt: '2024-12-13T17:08:43.585Z'
      },
      2: {
        stageType: 'ORDER',
        side: 'SELL',
        type: 'MARKET',
        asset: 'USDC',
        against: 'ARS',
        assetAmount: '10.51900785',
        price: '950.66',
        priceCode: '71c1a89a-7190-4287-82f6-79f0d4e17c0f'
      },
      3: {
        stageType: 'WITHDRAW',
        network: 'MANTECA',
        asset: 'ARS',
        amount: '10000',
        to: '999999999999999'
      }
    },
    creationTime: '2024-12-13T12:08:43.602-03:00',
    updatedAt: '2024-12-13T12:08:43.602-03:00'
  };

  return returnSuccessResponse(reply, 'ramp-off', rampOffResponse);
};
