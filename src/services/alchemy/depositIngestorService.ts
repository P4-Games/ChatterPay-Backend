import { ethers } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import { fromTopicAddress } from '../../helpers/alchemyHelper';
import { IExternalDeposit } from '../../models/externalDepositModel';
import { mongoExternalDepositsService } from '../mongo/mongoExternalDepositsService';
import { DEFAULT_CHAIN_ID, ALCHEMY_ERC20_TRANSFER_SIGNATURE } from '../../config/constants';
import {
  AlchemyLog,
  AlchemyTransaction,
  ExternalDepositEvent,
  AlchemyWebhookPayload,
  AlchemyAddressActivity
} from '../../types/alchemyTypes';

/**
 * Functional service for ingesting and processing Alchemy webhook deposit events
 */
export const depositIngestorService = {
  /**
   * Processes an Alchemy webhook payload and extracts deposit events
   */
  async processWebhookPayload(payload: AlchemyWebhookPayload): Promise<ExternalDepositEvent[]> {
    try {
      Logger.info('DepositIngestor', `Processing webhook payload ${payload.id}`, {
        type: payload.type,
        webhookId: payload.webhookId
      });

      const events: ExternalDepositEvent[] = [];

      // --- Case 1: legacy format with event.data.logs or event.data.transaction
      const { data } = payload.event;
      if (data?.logs || data?.transaction) {
        data.logs?.forEach((log: AlchemyLog) => {
          const erc20Event = depositIngestorService.processERC20Log(log);
          if (erc20Event) events.push(erc20Event);
        });

        if (data.transaction) {
          const ethEvent = depositIngestorService.processETHTransaction(data.transaction);
          if (ethEvent) events.push(ethEvent);
        }
      }

      // --- Case 2: new format with event.activity[]
      const { activity } = payload.event;
      if (Array.isArray(activity)) {
        activity.forEach((act: AlchemyAddressActivity) => {
          if (act.category === 'token' && act.log) {
            const erc20Event = depositIngestorService.processERC20Log(act.log);
            if (erc20Event) events.push(erc20Event);
          } else if (act.category === 'external' && act.hash) {
            // Fallback for ETH transfers
            const value = ethers.utils.parseUnits(String(act.value), 18).toString();
            const blockNumber = parseInt(act.blockNum, 16);

            const ethEvent: ExternalDepositEvent = {
              chainId: DEFAULT_CHAIN_ID,
              txHash: act.hash,
              logIndex: 0,
              from: act.fromAddress?.toLowerCase() ?? '',
              to: act.toAddress?.toLowerCase() ?? '',
              token: null,
              value,
              decimals: 18,
              blockNumber,
              provider: 'alchemy',
              status: 'observed'
            };
            events.push(ethEvent);
          }
        });
      }

      Logger.info(
        'DepositIngestor',
        `Extracted ${events.length} deposit events from payload ${payload.id}`
      );
      return events;
    } catch (error) {
      Logger.error('DepositIngestor', `Failed to process webhook payload ${payload.id}`, error);
      throw error;
    }
  },

  /**
   * Processes an ERC-20 Transfer log
   */
  processERC20Log(log: AlchemyLog): ExternalDepositEvent | null {
    try {
      if (log.topics.length < 3 || log.topics[0] !== ALCHEMY_ERC20_TRANSFER_SIGNATURE) {
        return null;
      }

      const tokenAddress = log.address.toLowerCase();
      const fromAddress = fromTopicAddress(log.topics[1]);
      const toAddress = fromTopicAddress(log.topics[2]);
      const amount = ethers.BigNumber.from(log.data).toString();

      const blockNumber = parseInt(log.blockNumber, 16);
      const logIndex = parseInt(log.logIndex, 16);

      Logger.debug('DepositIngestor', `Processing ERC-20 transfer`, {
        token: tokenAddress,
        from: fromAddress,
        to: toAddress,
        amount,
        txHash: log.transactionHash,
        logIndex
      });

      return {
        chainId: DEFAULT_CHAIN_ID,
        txHash: log.transactionHash,
        logIndex,
        from: fromAddress,
        to: toAddress,
        token: tokenAddress,
        value: amount,
        decimals: 18,
        blockNumber,
        provider: 'alchemy',
        status: 'observed'
      };
    } catch (error) {
      Logger.warn('DepositIngestor', `Failed to process ERC-20 log`, { log, error });
      return null;
    }
  },

  /**
   * Processes an ETH transaction
   */
  processETHTransaction(transaction: AlchemyTransaction): ExternalDepositEvent | null {
    try {
      const value = ethers.BigNumber.from(transaction.value);
      if (value.isZero()) return null;

      const blockNumber = parseInt(transaction.blockNumber, 16);

      Logger.debug('DepositIngestor', `Processing ETH transaction`, {
        from: transaction.from,
        to: transaction.to,
        value: value.toString(),
        txHash: transaction.hash
      });

      return {
        chainId: DEFAULT_CHAIN_ID,
        txHash: transaction.hash,
        logIndex: 0,
        from: transaction.from.toLowerCase(),
        to: transaction.to?.toLowerCase() || '',
        token: null,
        value: value.toString(),
        decimals: 18,
        blockNumber,
        provider: 'alchemy',
        status: 'observed'
      };
    } catch (error) {
      Logger.warn('DepositIngestor', `Failed to process ETH transaction`, { transaction, error });
      return null;
    }
  },

  /**
   * Complete processing pipeline: parse webhook, persist events, and emit domain events
   */
  async ingestDeposits(payload: AlchemyWebhookPayload): Promise<IExternalDeposit[]> {
    try {
      const events = await depositIngestorService.processWebhookPayload(payload);
      if (events.length === 0) {
        Logger.debug('DepositIngestor', `No deposit events found in payload ${payload.id}`);
        return [];
      }

      const persistedEvents = await mongoExternalDepositsService.persistDepositEvents(events);
      persistedEvents.forEach((event) => depositIngestorService.emitDepositEvent(event));

      return persistedEvents;
    } catch (error) {
      Logger.error(
        'DepositIngestor',
        `Failed to ingest deposits from payload ${payload.id}`,
        error
      );
      throw error;
    }
  },

  /**
   * Emits domain event for deposit processing
   */
  emitDepositEvent(deposit: IExternalDeposit): void {
    const { _id, to, token, value, chainId } = deposit;
    Logger.info('DepositIngestor', `Deposit event ready for processing`, {
      id: _id,
      to,
      token,
      value,
      chainId
    });
  }
};
