import { Logger } from '../../helpers/loggerHelper';
import Transaction from '../../models/transactionModel';

export const mongoTransactionService = {
  /**
   * Saves the transaction details to the database.
   */
  saveTransaction: async (
    tx: string,
    walletFrom: string,
    walletTo: string,
    amount: number,
    token: string,
    type: string,
    status: string
  ) => {
    try {
      await Transaction.create({
        trx_hash: tx,
        wallet_from: walletFrom,
        wallet_to: walletTo,
        type,
        date: new Date(),
        status,
        amount,
        token
      });
    } catch (error: unknown) {
      // avoid throw error
      Logger.error(
        'saveTransaction',
        `Error saving transaction ${tx} in database from: ${walletFrom}, to: ${walletTo}, amount: ${amount.toString()}, token: ${token}}:`,
        (error as Error).message
      );
    }
  }
};
