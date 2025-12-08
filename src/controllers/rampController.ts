import { FastifyReply, FastifyRequest } from 'fastify';

import { IUser } from '../models/userModel';
import { IToken } from '../models/tokenModel';
import { Logger } from '../helpers/loggerHelper';
import { getUser } from '../services/userService';
import { mantecaUserService } from '../services/manteca/user/mantecaUserService';
import { mantecaPriceService } from '../services/manteca/market/mantecaPriceService';
import { mantecaWidgetService } from '../services/manteca/user/mantecaWidgetService';
import { mantecaBalanceService } from '../services/manteca/user/mantecaBalanceService';
import {
  MantecaUserBalance,
  MantecaOperationSide,
  MantecaWidgetOnboarding
} from '../types/mantecaType';
import {
  returnErrorResponse,
  returnSuccessResponse,
  returnErrorResponse500
} from '../helpers/requestHelper';
import {
  ONRAMP_APP_ID,
  FIAT_CURRENCIES,
  ONRAMP_BASE_URL,
  CHATIZALO_PHONE_NUMBER,
  ONRAMP_DEFAULT_NETWORK,
  ONRAMP_DEFAULT_COIN_CODE,
  COMMON_REPLY_WALLET_NOT_CREATED,
  MANTECA_MOCK_UPLOAD_DOCUMENTS_URL
} from '../config/constants';

interface widgetLinkToOperateBody {
  channel_user_id: string;
  operation: MantecaOperationSide;
  asset: string;
  against: string;
  assetAmount: number | string;
}

interface ValidateInputsLinkToOperateParams {
  fromUser: IUser | null;
  operation: string;
  asset: string;
  against: string;
  tokens: IToken[];
  assetAmount: number | string;
}

async function validateInputsLinkToOperate(
  params: ValidateInputsLinkToOperateParams
): Promise<string | null> {
  const { fromUser, operation, asset, against, tokens, assetAmount } = params;

  if (!fromUser) {
    return COMMON_REPLY_WALLET_NOT_CREATED;
  }

  if (!FIAT_CURRENCIES.includes(against)) {
    return `Invalid currency: "${against}". Must be one of ${FIAT_CURRENCIES.join(', ')}.`;
  }

  if (!['BUY', 'SELL'].includes(operation.toUpperCase())) {
    return `Invalid operation: "${operation}". Must be either "BUY" or "SELL".`;
  }

  const validToken = tokens.find(
    (token) => token.name.toLowerCase() === asset.toLowerCase() && token.ramp_enabled
  );

  if (!validToken) {
    return `Invalid asset: "${asset}". Must be a token with ramp_enabled = true.`;
  }

  const amount = parseFloat(String(assetAmount).trim());
  if (Number.isNaN(amount) || amount <= 0) {
    return `Invalid amount: "${assetAmount}". Must be a number greater than 0.`;
  }

  return null;
}

export const linkToOperate = async (
  request: FastifyRequest<{
    Body: widgetLinkToOperateBody;
    Querystring?: { lastBotMsgDelaySeconds?: number };
  }>,
  reply: FastifyReply
) => {
  Logger.log('widgetLinkToOperate', 'Get Ramp Widget Link to operate');

  if (!request.body) {
    return returnErrorResponse('linkToOperate', '', reply, 400, 'Request body is required');
  }

  const { channel_user_id, operation, asset, against, assetAmount } = request.body;
  const fromUser: IUser | null = await getUser(channel_user_id);

  const errorMessage = await validateInputsLinkToOperate({
    fromUser,
    operation,
    asset,
    against,
    tokens: request.server.tokens,
    assetAmount
  });

  if (errorMessage) {
    Logger.info('widgetLinkToOperate', errorMessage);
    // Returns a response with the error message but with a 200 status code
    return returnSuccessResponse(reply, errorMessage);
  }

  const network = request.server.networkConfig.manteca_name;
  const userWallet = fromUser!.wallets[0].wallet_proxy;
  const userMantecaid = fromUser!.manteca_user_id || `user-${fromUser!.id}`;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const sessionId = `session-${date}-${userMantecaid.slice(5)}`;
  const returnUrlOk = `https://api.whatsapp.com/send/?phone=${CHATIZALO_PHONE_NUMBER}&text=operacion-realizada`;
  const returnUrlErr = `https://api.whatsapp.com/send/?phone=${CHATIZALO_PHONE_NUMBER}&text=error-con-la-operacion`;

  const widgetOptions: MantecaWidgetOnboarding = {
    userExternalId: `${userMantecaid}`,
    sessionId: `${sessionId}`,
    returnUrl: `${returnUrlOk}`,
    failureUrl: `${returnUrlErr}`,
    options: {
      endOnOperation: false,
      endOnOperationWaiting: false,
      side: `${operation}`,
      asset: `${asset}`,
      against: `${against}`,
      assetAmount: `${assetAmount}`,
      withdrawAddress: `${userWallet}`,
      withdrawNetwork: `${network}`
    }
  };
  Logger.log('manteca', widgetOptions);

  try {
    const link: string = await mantecaWidgetService.getLinkToOperate(widgetOptions);
    return await returnSuccessResponse(
      reply,
      `Click in this link to continue with Manteca: ${link}`
    );
  } catch (error) {
    Logger.error('widgetLinkToOperate', 'Error getting ramp widget link to operate:', error);
    return returnErrorResponse500('linkToOperate', '', reply);
  }
};

/**
 * Handles the full onboarding process for a new user.
 * This function performs the following steps:
 * 1. Creates a new user in the system.
 * 2. Uploads the user's compliance documents.
 * 3. Adds a bank account for the user.
 *
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const onBoarding = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('onBoarding', 'Full onBoarding user: create + compliance + bank Account');

  const userCreated =
    // await mantecaUserService.createUser(mockCreateUser);
    {
      numberId: '100001086',
      userId: '100001086',
      email: 'john@smsith.com',
      cuit: '23123456789',
      country: 'Argentina',
      phoneNumber: '5491135354489',
      civilState: 'soltero',
      name: 'John Smith',
      creationTime: '2023-12-05T18:16:57.467Z',
      externalId: 'identificador-externo-1',
      bankAccounts: {
        ARS: [],
        USD: []
      },
      balance: {
        fiat: {
          ARS: {
            amount: '0'
          },
          USD: {
            amount: '0'
          }
        },
        crypto: {}
      },
      addresses: {
        evm: '',
        terra: ''
      }
    };
  return returnSuccessResponse(reply, 'User created successfully', { user: userCreated });
};

/**
 * Controller for creating a new user.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const createRampUser = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('createUser', 'Creating a new user in Manteca');
  /*
  const mockCreateUser: MantecaUserCreate = {
    name: 'John Smith',
    email: 'john@smith.com',
    legalId: '23123456789',
    phoneNumber: '5491135354489',
    country: 'Argentina',
    civilState: 'SOLTERO',
    externalId: 'identificador-externo-1',
    address: 'Los Tres Patitios 123',
    isPep: false,
    isFatca: false,
    isUif: false
  };
  */

  // TO-REVIEW: Falla el create User en el sandbox, porque no tiene el campo address y no está en la documentación como se completa.
  // https://docs.manteca.dev/api-runner/mantecadev/cripto/gestion-de-usuarios/usuarios-1/crear-usuario
  const userCreated =
    // await mantecaUserService.createUser(mockCreateUser);
    {
      numberId: '100001086',
      userId: '100001086',
      email: 'john@smsith.com',
      cuit: '23123456789',
      country: 'Argentina',
      phoneNumber: '5491135354489',
      civilState: 'soltero',
      name: 'John Smith',
      creationTime: '2023-12-05T18:16:57.467Z',
      externalId: 'identificador-externo-1',
      bankAccounts: {
        ARS: [],
        USD: []
      },
      balance: {
        fiat: {
          ARS: {
            amount: '0'
          },
          USD: {
            amount: '0'
          }
        },
        crypto: {}
      },
      addresses: {
        evm: '',
        terra: ''
      }
    };
  return returnSuccessResponse(reply, 'User created successfully', { user: userCreated });
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

  Logger.log(
    'userUploadDocuments',
    `Uploading document to URL: ${MANTECA_MOCK_UPLOAD_DOCUMENTS_URL}`
  );
  return returnSuccessResponse(reply, 'Document uploaded successfully');
};

/**
 * Controller for getting account validation status.
 * Returns a boolean indicating whether the user is validated.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const getRampUserValidationStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  const { userId } = request.params as { userId: string };
  Logger.log('getUserValidationStatus', `Getting validation status for user ID: ${userId}`);

  // Mocking the validation status response
  const isValidated = true;

  return returnSuccessResponse(reply, `${isValidated}`);
};

/**
 * Controller to get the document status of a specific user.
 * @param request - Fastify request object containing the userId in params.
 * @param reply - Fastify reply object.
 * @returns A list of documents with their status for the user.
 */
export const getRampUserDocumentsStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  const { userId } = request.params as { userId: string };
  Logger.log('getUserDocumentStatus', `Fetching document status for user ID: ${userId}`);

  // Mocked response for a user's document status
  const documentStatus = [
    {
      date: '2022-12-27T17:56:39.423Z',
      type: 'DNI_FRONT',
      status: 'VALIDATED',
      comment: ''
    },
    {
      date: '2022-12-27T17:56:39.423Z',
      type: 'DNI_BACK',
      status: 'VALIDATED',
      comment: ''
    },
    {
      date: '2023-12-22T15:32:24.404Z',
      type: 'FUNDS',
      status: 'PENDING'
    }
  ];

  return returnSuccessResponse(reply, 'documents status', { documents: documentStatus });
};

/**
 * Controller to get the document status of multiple users.
 * Mocked response returning the document status for 10 users.
 * @param request - Fastify request object.
 * @param reply - Fastify reply object.
 * @returns A list of document statuses for multiple users.
 */
export const checkRampUsersStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('getMultipleUserDocumentStatuses', `Fetching document statuses for multiple users`);

  // Mocked response for multiple users
  const documentStatuses = Array.from({ length: 10 }, (_, index) => ({
    userId: `user-${index + 1}`,
    documents: [
      {
        date: '2022-12-27T17:56:39.423Z',
        type: 'DNI_FRONT',
        status: index % 2 === 0 ? 'VALIDATED' : 'PENDING',
        comment: ''
      },
      {
        date: '2022-12-27T17:56:39.423Z',
        type: 'DNI_BACK',
        status: index % 2 === 0 ? 'VALIDATED' : 'PENDING',
        comment: ''
      },
      {
        date: '2023-12-22T15:32:24.404Z',
        type: 'FUNDS',
        status: index % 3 === 0 ? 'VALIDATED' : 'PENDING'
      }
    ]
  }));

  return returnSuccessResponse(reply, 'users documents status', { users: documentStatuses });
};

/**
 * Controller for getting user limits.
 * Returns monthly and yearly limits based on the user's economic level.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const getRampUserLimits = async (request: FastifyRequest, reply: FastifyReply) => {
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
export const getRampUserBalance = async (request: FastifyRequest, reply: FastifyReply) => {
  const { userId } = request.params as { userId: string };
  Logger.log('getUserBalance', `Getting balance for user ID: ${userId}`);

  /*
  let balance = {
    fiat: {
      ARS: { amount: '0' }
    },
    crypto: {
      WLD: { amount: '0', weiAmount: '0' },
      USDC: { amount: '0', weiAmount: '0' }
    },
    locked: {
      fiat: {
        ARS: { amount: '0' }
      },
      crypto: {}
    }
  };
*/

  try {
    await mantecaUserService.getUserById(userId);
  } catch (error: unknown) {
    return returnErrorResponse('getRampUserBalance', '', reply, 404, 'user not found');
  }

  const balance: MantecaUserBalance = await mantecaBalanceService.getUserBalance(userId);

  // Mocking the user's balance response
  /*
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
  */
  return returnSuccessResponse(reply, 'user balance', { balance });
};

/**
 * Controller for getting prices of currency pairs.
 * Returns the buy and sell prices for pairs such as BTC_ARS, BTC_USD, etc.
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200
 */
export const getRampCryptoPairPrices = async (request: FastifyRequest, reply: FastifyReply) => {
  Logger.log('getRampCryptoPairPrices', 'Fetching prices for currency pairs');
  const prices = await mantecaPriceService.getAllPrices();
  return returnSuccessResponse(reply, 'prices', prices);
};

/**
 * Controller to add a bank account to the user's profile.
 * This function simulates adding a bank account by returning a mock response.
 * The "cbu" parameter can accept a CBU, CVU, or alias for Argentina, while in other countries it accepts only the bank account number.
 * The bank account must be in the user's name and cannot belong to third parties.
 *
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200 and the details of the added bank account
 */
export const addRampUserBankAccount = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const { numberId, coin } = request.params as { numberId: string; coin: string };
  const { cbu } = request.body as { cbu: string; description: string };

  Logger.log(
    'addRampUserBankAccount',
    `Adding bank account for user ID: ${numberId}, Coin: ${coin}, CBU: ${cbu}`
  );

  const mockResponse = {
    bankCode: '-',
    bankName: '-',
    description: 'Santander Rio',
    cbu: '999999999999999',
    cvu: false,
    actualCbu: '999999999999999'
  };

  return returnSuccessResponse(reply, 'Bank account added', mockResponse);
};

/**
 * Controller to delete a bank account from the user's profile.
 * This function simulates deleting a bank account by returning an empty mock response.
 *
 * @param request - Fastify request object
 * @param reply - Fastify reply object
 * @returns Response with status 200 and an empty body
 */
export const removeRampUserBankAccount = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const { numberId, coin, cbu } = request.params as { numberId: string; coin: string; cbu: string };

  Logger.log(
    'removeRampUserBankAccount',
    `Removing bank account for user ID: ${numberId}, Coin: ${coin}, CBU: ${cbu}`
  );

  return returnSuccessResponse(reply, 'Bank account removed', {});
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

/**
 * Controller for generating an on-ramp link for a given phone number.
 * Retrieves the wallet address associated with the phone number and returns
 * the formatted on-ramp URL.
 *
 * @param request - Fastify request object containing the phone number
 * @param reply - Fastify reply object
 * @returns Response with status 200 and the on-ramp link
 */
export const generateOnRampLink = async (
  request: FastifyRequest<{
    Body: { phone_number: string };
  }>,
  reply: FastifyReply
) => {
  Logger.log('generateOnRampLink', 'Generating on-ramp link for user');

  if (!request.body) {
    return returnErrorResponse('generateOnRampLink', '', reply, 400, 'Request body is required');
  }

  const { phone_number } = request.body;

  if (!phone_number) {
    return returnErrorResponse(
      'generateOnRampLink',
      '',
      reply,
      400,
      'Missing "phone_number" in the request body'
    );
  }

  const fromUser: IUser | null = await getUser(phone_number);

  if (!fromUser) {
    return returnErrorResponse(
      'generateOnRampLink',
      phone_number,
      reply,
      404,
      COMMON_REPLY_WALLET_NOT_CREATED
    );
  }

  if (!fromUser.wallets || fromUser.wallets.length === 0) {
    return returnErrorResponse(
      'generateOnRampLink',
      phone_number,
      reply,
      404,
      'User has no wallet associated'
    );
  }

  const walletAddress = fromUser.wallets[0].wallet_proxy;

  const onRampLink = `${ONRAMP_BASE_URL}?appId=${ONRAMP_APP_ID}&coinCode=${ONRAMP_DEFAULT_COIN_CODE}&network=${ONRAMP_DEFAULT_NETWORK}&walletAddress=${walletAddress}`;

  Logger.log('generateOnRampLink', `On-ramp link generated for ${phone_number}: ${onRampLink}`);

  return returnSuccessResponse(reply, 'on-ramp link generated successfully', { link: onRampLink });
};
