import axios from 'axios';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { Logger } from '../../../helpers/loggerHelper';
import type { MantecaRampOff, MantecaRampOn } from '../../../types/mantecaType';
import { getMantecaAxiosConfig } from '../mantecaCommonService';

export const mantecaSyntheticsService = {
  /**
   * Performs a ramp-on operation, which involves purchasing cryptocurrency and withdrawing it automatically.
   * The process starts once the required FIAT funds are sent to the given address.
   *
   * @param {string} externalId - The external identifier for the ramp-on operation.
   * @param {string} userAnyId - The identifier for the user initiating the operation.
   * @param {string} sessionId - The session ID for the ramp-on operation.
   * @param {string} asset - The asset to buy (e.g., "USDC").
   * @param {string} against - The currency to use for the purchase (e.g., "ARS").
   * @param {number} assetAmount - The amount of the asset to buy.
   * @param {string} priceCode - The price code for the operation.
   * @param {string} withdrawAddress - The address to withdraw the asset to.
   * @param {string} withdrawNetwork - The network for withdrawal.
   * @param {string} apiKey - The API key for authentication.
   * @returns {object} Details of the ramp-on operation, including deposit and withdrawal information.
   *
   * @example
   * {
   *   "id": "675c39a4ca5811051b7ec211",
   *   "externalId": "externalId-synth-001",
   *   "status": "PENDING",
   *   "asset": "USDC",
   *   "amount": 0.9999,
   *   "withdrawAddress": "0x3f2e9f249E19e74a23eDA48246D84D5c1f29559D",
   *   "timestamp": "2025-01-11T10:11:52",
   *   "message": "Ramp-on operation is in progress."
   * }
   */
  rampOn: async (
    externalId: string,
    userAnyId: string,
    sessionId: string,
    asset: string,
    against: string,
    assetAmount: string,
    priceCode: string,
    withdrawAddress: string,
    withdrawNetwork: string
  ): Promise<MantecaRampOn> => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/synthetics/ramp-on`,
        {
          externalId,
          userAnyId,
          sessionId,
          asset,
          against,
          assetAmount,
          priceCode,
          withdrawAddress,
          withdrawNetwork
        },
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('rampOn', error);
      throw error;
    }
  },

  /**
   * Performs a ramp-off operation, which involves selling cryptocurrency and withdrawing the resulting assets automatically.
   * Once the synthetic asset is created, the system will provide the crypto address to which the funds must be sent to trigger the process,
   * along with the supported networks. If insufficient funds are sent, the synthetic will not be processed.
   * If excess funds are sent, they will be processed without issue (all funds received since the creation of the synthetic).
   * For a ramp-off that accumulates funds in the user balance instead of sending them, use the alias 'partial-ramp-off',
   * where the 'withdrawAddress' field becomes optional as only the deposit and order stages will be involved.
   *
   * @param {string} externalId - The external identifier for the ramp-off operation.
   * @param {string} userAnyId - The identifier for the user initiating the operation.
   * @param {string} sessionId - The session ID for the ramp-off operation.
   * @param {string} asset - The asset to sell (e.g., "USDC").
   * @param {string} against - The currency to sell the asset against (e.g., "ARS").
   * @param {string} againstAmount - The amount of the 'against' asset involved in the transaction (e.g., "10.5 ARS").
   * @param {string} priceCode - The price code for the transaction.
   * @param {string} withdrawAddress - The address to withdraw the asset to (optional for partial ramp-off).
   * @returns {object} The details of the ramp-off operation, including deposit, order, and withdrawal information.
   *
   * @example
   * {
   *   "id": "675c4dfb7a7c317162a06bd3",
   *   "externalId": "externalId-synth-ramp-off-12",
   *   "status": "STARTING",
   *   "details": {
   *     "depositAddress": "0x701d632075ffe6D70D06bD390C979Ad7EB16Dc61",
   *     "depositAvailableNetworks": ["ETHEREUM", "BINANCE", "POLYGON", "OPTIMISM", "BASE", "ARBITRUM", "INTERNAL"],
   *     "withdrawCostInAgainst": "0",
   *     "withdrawCostInAsset": "0"
   *   },
   *   "currentStage": 1,
   *   "stages": {
   *     "1": {
   *       "stageType": "DEPOSIT",
   *       "asset": "USDC",
   *       "tresholdAmount": "10.51900785",
   *       "expireAt": "2024-12-13T17:08:43.585Z"
   *     },
   *     "2": {
   *       "stageType": "ORDER",
   *       "side": "SELL",
   *       "asset": "USDC",
   *       "against": "ARS",
   *       "assetAmount": "10.51900785",
   *       "price": "950.66"
   *     },
   *     "3": {
   *       "stageType": "WITHDRAW",
   *       "network": "MANTECA",
   *       "asset": "ARS",
   *       "amount": "10000",
   *       "to": "999999999999999"
   *     }
   *   },
   *   "creationTime": "2024-12-13T12:08:43.602-03:00",
   *   "updatedAt": "2024-12-13T12:08:43.602-03:00"
   * }
   */
  rampOff: async (
    externalId: string,
    userAnyId: string,
    sessionId: string,
    asset: string,
    against: string,
    againstAmount: string,
    priceCode: string,
    withdrawAddress: string
  ): Promise<MantecaRampOff> => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/synthetics/ramp-off`,
        {
          externalId,
          userAnyId,
          sessionId,
          asset,
          against,
          againstAmount,
          priceCode,
          withdrawAddress
        },
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('rampOff', error);
      throw error;
    }
  }
};
