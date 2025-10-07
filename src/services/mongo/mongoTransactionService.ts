import { Logger } from '../../helpers/loggerHelper';
import Transaction from '../../models/transactionModel';
import { TransactionData } from '../../types/commonType';

export const mongoTransactionService = {
  /**
   * Saves the transaction details to the database.
   */
  saveTransaction: async (transactionData: TransactionData) => {
    try {
      const {
        tx,
        walletFrom,
        walletTo,
        amount,
        fee,
        token,
        type,
        status,
        chain_id,
        date,
        user_notes
      } = transactionData;

      await Transaction.create({
        trx_hash: tx,
        wallet_from: walletFrom,
        wallet_to: walletTo,
        type,
        date: date || new Date(),
        status,
        amount,
        fee,
        token,
        chain_id,
        user_notes: user_notes || ''
      });
    } catch (error: unknown) {
      // avoid throw error
      Logger.error(
        'saveTransaction',
        `Error saving transaction ${transactionData.tx} in database from: ${transactionData.walletFrom}, to: ${transactionData.walletTo}, amount: ${transactionData.amount.toString()}, token: ${transactionData.token}:`,
        (error as Error).message
      );
    }
  },

  /**
   * Checks whether a transaction exists by its hash.
   *
   * @param {string} tx - Transaction hash to check.
   * @returns {Promise<boolean>} True if a document with this hash exists.
   */
  existsByHash: async (tx: string): Promise<boolean> => {
    try {
      const found = await Transaction.exists({ trx_hash: tx });
      return Boolean(found);
    } catch (error: unknown) {
      Logger.error(
        'existsByHash',
        `Error checking transaction existence for ${tx}:`,
        (error as Error).message
      );
      return false;
    }
  }
};
