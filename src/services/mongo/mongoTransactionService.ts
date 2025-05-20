import { Logger } from '../../helpers/loggerHelper';
import Transaction from '../../models/transactionModel';
import { TransactionData } from '../../types/commonType';

export const mongoTransactionService = {
  /**
   * Saves the transaction details to the database.
   */
  saveTransaction: async (transactionData: TransactionData) => {
    try {
      const { tx, walletFrom, walletTo, amount, fee, token, type, status, chain_id } =
        transactionData;

      await Transaction.create({
        trx_hash: tx,
        wallet_from: walletFrom,
        wallet_to: walletTo,
        type,
        date: new Date(),
        status,
        amount,
        fee,
        token,
        chain_id
      });
    } catch (error: unknown) {
      // avoid throw error
      Logger.error(
        'saveTransaction',
        `Error saving transaction ${transactionData.tx} in database from: ${transactionData.walletFrom}, to: ${transactionData.walletTo}, amount: ${transactionData.amount.toString()}, token: ${transactionData.token}:`,
        (error as Error).message
      );
    }
  }
};
