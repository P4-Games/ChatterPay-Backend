import { Logger } from '../../helpers/loggerHelper';
import { ExternalDepositEvent } from '../../types/alchemyTypes';
import { IExternalDeposit, ExternalDepositModel } from '../../models/externalDepositModel';

/**
 * Mongo service for persisting and retrieving external deposit events.
 */
export const mongoExternalDepositsService = {
  /**
   * Persist a batch of deposit events with idempotency.
   *
   * @param events - The deposit events to upsert
   * @returns The persisted deposit documents
   */
  persistDepositEvents: async (events: ExternalDepositEvent[]): Promise<IExternalDeposit[]> => {
    const persisted: IExternalDeposit[] = [];

    await Promise.all(
      events.map(async (event) => {
        try {
          const doc = await ExternalDepositModel.findOneAndUpdate(
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
          ).lean();

          if (doc) persisted.push(doc as IExternalDeposit);

          Logger.debug('mongoExternalDepositsService', 'Persisted deposit event', {
            txHash: event.txHash,
            logIndex: event.logIndex,
            to: event.to,
            token: event.token,
            value: event.value
          });
        } catch (err: unknown) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: number }).code === 11000
          ) {
            Logger.debug('mongoExternalDepositsService', 'Duplicate deposit event ignored', {
              txHash: event.txHash,
              logIndex: event.logIndex
            });
          } else {
            Logger.error('mongoExternalDepositsService', 'Failed to persist deposit event', {
              event,
              err
            });
          }
        }
      })
    );

    Logger.info(
      'mongoExternalDepositsService',
      `Persisted ${persisted.length}/${events.length} deposit events`
    );

    return persisted;
  },

  /**
   * Find a deposit by transaction hash and log index.
   */
  getDepositByTxAndIndex: async (
    txHash: string,
    logIndex: number
  ): Promise<IExternalDeposit | null> => {
    try {
      return await ExternalDepositModel.findOne({ txHash, logIndex }).lean();
    } catch (err) {
      Logger.error('mongoExternalDepositsService', 'getDepositByTxAndIndex DB error:', err);
      return null;
    }
  },

  /**
   * Retrieve all deposits observed in the last N hours.
   */
  getRecentDeposits: async (hours: number): Promise<IExternalDeposit[]> => {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    try {
      return await ExternalDepositModel.find({ observedAt: { $gte: since } }).lean();
    } catch (err) {
      Logger.error('mongoExternalDepositsService', 'getRecentDeposits DB error:', err);
      return [];
    }
  },

  /**
   * Retrieves Alchemy deposits pending processing.
   *
   * @param {number} chainId - Target chain id.
   * @returns {Promise<readonly IExternalDeposit[]>} Deposits with status != 'processed'.
   */
  async getUnprocessedAlchemyDeposits(chainId: number): Promise<readonly IExternalDeposit[]> {
    try {
      return await ExternalDepositModel.find({
        chainId,
        provider: 'alchemy',
        status: { $ne: 'processed' }
      })
        .sort({ observedAt: 1 })
        .lean();
    } catch (err) {
      Logger.error('mongoExternalDepositsService', 'getUnprocessedAlchemyDeposits DB error:', err);
      return [];
    }
  },

  /**
   * Marks an external deposit as processed by document id.
   *
   * @param {string} id - Mongo _id of the deposit.
   * @returns {Promise<void>} Resolves after update.
   */
  async markAsProcessedById(id: string): Promise<void> {
    try {
      await ExternalDepositModel.updateOne({ _id: id }, { $set: { status: 'processed' } });
    } catch (err) {
      Logger.error('mongoExternalDepositsService', 'markAsProcessedById DB error:', err);
    }
  },

  /**
   * Marks external deposits as processed using tx hash and chain id.
   *
   * @param {string} txHash - Transaction hash.
   * @param {number} chainId - Chain id.
   * @returns {Promise<void>} Resolves after update.
   */
  async markAsProcessedByHash(txHash: string, chainId: number): Promise<void> {
    try {
      await ExternalDepositModel.updateMany(
        { txHash, chainId, provider: 'alchemy' },
        { $set: { status: 'processed' } }
      );
    } catch (err) {
      Logger.error('mongoExternalDepositsService', 'markAsProcessedByHash DB error:', err);
    }
  }
};
