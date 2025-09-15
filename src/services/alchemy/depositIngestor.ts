import { ethers } from 'ethers';
import { Logger } from '../../helpers/loggerHelper';
import { ExternalDepositModel, IExternalDeposit } from '../../models/externalDepositModel';
import { fromTopicAddress } from '../../helpers/alchemyHelper';
import { ERC20_TRANSFER_SIG, DEFAULT_CHAIN_ID } from '../../config/constants';

// Alchemy webhook payload interfaces
export interface AlchemyLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
}

export interface AlchemyTransaction {
  hash: string;
  nonce: string;
  blockHash: string;
  blockNumber: string;
  transactionIndex: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasPrice: string;
  input: string;
}

export interface AlchemyWebhookPayload {
  webhookId: string;
  id: string;
  createdAt: string;
  type: 'GRAPHQL' | 'MINED_TRANSACTION' | 'DROPPED_TRANSACTION';
  event: {
    data: {
      block: {
        hash: string;
        number: string;
        timestamp: string;
      };
      logs?: AlchemyLog[];
      transaction?: AlchemyTransaction;
    };
  };
}

export interface DepositEvent {
  chainId: number;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  token: string | null;
  value: string;
  decimals: number;
  blockNumber: number;
  provider: 'alchemy';
  status: 'observed';
}

/**
 * Service for ingesting and processing Alchemy webhook deposit events
 */
export class DepositIngestor {
  private readonly chainId: number;

  constructor(chainId?: number) {
    this.chainId = chainId || DEFAULT_CHAIN_ID;
  }

  /**
   * Processes an Alchemy webhook payload and extracts deposit events
   * @param payload - The webhook payload from Alchemy
   * @returns Array of processed deposit events
   */
  public async processWebhookPayload(payload: AlchemyWebhookPayload): Promise<DepositEvent[]> {
    try {
      Logger.info('DepositIngestor', `Processing webhook payload ${payload.id}`, {
        type: payload.type,
        webhookId: payload.webhookId
      });

      const events: DepositEvent[] = [];
      const { data } = payload.event;

      // Process ERC-20 transfer logs
      if (data.logs) {
        for (const log of data.logs) {
          const erc20Event = this.processERC20Log(log);
          if (erc20Event) {
            events.push(erc20Event);
          }
        }
      }

      // Process ETH transactions
      if (data.transaction) {
        const ethEvent = this.processETHTransaction(data.transaction);
        if (ethEvent) {
          events.push(ethEvent);
        }
      }

      Logger.info('DepositIngestor', `Extracted ${events.length} deposit events from payload ${payload.id}`);
      return events;
    } catch (error) {
      Logger.error('DepositIngestor', `Failed to process webhook payload ${payload.id}`, error);
      throw error;
    }
  }

  /**
   * Processes an ERC-20 Transfer log
   * @param log - The log entry from Alchemy
   * @returns DepositEvent if valid transfer, null otherwise
   */
  private processERC20Log(log: AlchemyLog): DepositEvent | null {
    try {
      // Check if this is a Transfer event
      if (log.topics.length < 3 || log.topics[0] !== ERC20_TRANSFER_SIG) {
        return null;
      }

      // Extract transfer details
      const tokenAddress = log.address.toLowerCase();
      const fromAddress = fromTopicAddress(log.topics[1]);
      const toAddress = fromTopicAddress(log.topics[2]);
      
      // Parse the amount from data field (uint256)
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
        chainId: this.chainId,
        txHash: log.transactionHash,
        logIndex,
        from: fromAddress,
        to: toAddress,
        token: tokenAddress,
        value: amount,
        decimals: 18, // Default, will be updated if token info is available
        blockNumber,
        provider: 'alchemy',
        status: 'observed'
      };
    } catch (error) {
      Logger.warn('DepositIngestor', `Failed to process ERC-20 log`, { log, error });
      return null;
    }
  }

  /**
   * Processes an ETH transaction
   * @param transaction - The transaction from Alchemy
   * @returns DepositEvent if valid ETH transfer, null otherwise
   */
  private processETHTransaction(transaction: AlchemyTransaction): DepositEvent | null {
    try {
      // Only process transactions with value > 0
      const value = ethers.BigNumber.from(transaction.value);
      if (value.isZero()) {
        return null;
      }

      const blockNumber = parseInt(transaction.blockNumber, 16);

      Logger.debug('DepositIngestor', `Processing ETH transaction`, {
        from: transaction.from,
        to: transaction.to,
        value: value.toString(),
        txHash: transaction.hash
      });

      return {
        chainId: this.chainId,
        txHash: transaction.hash,
        logIndex: 0, // ETH transfers don't have log index, use 0
        from: transaction.from.toLowerCase(),
        to: transaction.to?.toLowerCase() || '',
        token: null, // null indicates ETH
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
  }

  /**
   * Persists deposit events to database with idempotency
   * @param events - Array of deposit events to persist
   * @returns Array of successfully persisted events
   */
  public async persistDepositEvents(events: DepositEvent[]): Promise<IExternalDeposit[]> {
    const persistedEvents: IExternalDeposit[] = [];

    for (const event of events) {
      try {
        // Use upsert to handle idempotency
        const depositDoc = await ExternalDepositModel.findOneAndUpdate(
          {
            chainId: event.chainId,
            txHash: event.txHash,
            logIndex: event.logIndex
          },
          {
            ...event,
            observedAt: new Date()
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
          }
        );

        persistedEvents.push(depositDoc);
        
        Logger.debug('DepositIngestor', `Persisted deposit event`, {
          id: depositDoc._id,
          txHash: event.txHash,
          logIndex: event.logIndex,
          to: event.to,
          token: event.token,
          value: event.value
        });
      } catch (error) {
        // Handle duplicate key errors gracefully
        if ((error as any).code === 11000) {
          Logger.debug('DepositIngestor', `Duplicate deposit event ignored`, {
            txHash: event.txHash,
            logIndex: event.logIndex
          });
        } else {
          Logger.error('DepositIngestor', `Failed to persist deposit event`, { event, error });
        }
      }
    }

    Logger.info('DepositIngestor', `Persisted ${persistedEvents.length}/${events.length} deposit events`);
    return persistedEvents;
  }

  /**
   * Complete processing pipeline: parse webhook, persist events, and emit domain events
   * @param payload - The webhook payload from Alchemy
   * @returns Array of persisted deposit events
   */
  public async ingestDeposits(payload: AlchemyWebhookPayload): Promise<IExternalDeposit[]> {
    try {
      // Parse webhook payload
      const events = await this.processWebhookPayload(payload);
      
      if (events.length === 0) {
        Logger.debug('DepositIngestor', `No deposit events found in payload ${payload.id}`);
        return [];
      }

      // Persist events to database
      const persistedEvents = await this.persistDepositEvents(events);

      // TODO: Emit domain events for downstream processing
      // This would trigger notifications, balance updates, etc.
      for (const event of persistedEvents) {
        this.emitDepositEvent(event);
      }

      return persistedEvents;
    } catch (error) {
      Logger.error('DepositIngestor', `Failed to ingest deposits from payload ${payload.id}`, error);
      throw error;
    }
  }

  /**
   * Emits domain event for deposit processing
   * @param deposit - The persisted deposit event
   */
  private emitDepositEvent(deposit: IExternalDeposit): void {
    // TODO: Implement event bus integration
    // Example: eventBus.publish('deposit.observed', { deposit });
    Logger.info('DepositIngestor', `Deposit event ready for processing`, {
      id: deposit._id,
      to: deposit.to,
      token: deposit.token,
      value: deposit.value,
      chainId: deposit.chainId
    });
  }
}

// Export singleton instance
export const depositIngestor = new DepositIngestor();
