import { Logger } from '../../helpers/loggerHelper';
import Transaction from '../../models/transactionModel';
import type { TransactionData } from '../../types/commonType';

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
        user_notes,
        polymarket_order_id,
        polymarket_purchase_id,
        polymarket_market_slug,
        polymarket_size,
        polymarket_bridge_tx_hash,
        polymarket_bridge_amount,
        polymarket_bridge_token,
        network_fee,
        network_fee_token
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
        user_notes: user_notes || '',
        polymarket_order_id,
        polymarket_purchase_id,
        polymarket_market_slug,
        polymarket_size,
        polymarket_bridge_tx_hash,
        polymarket_bridge_amount,
        polymarket_bridge_token,
        network_fee,
        network_fee_token
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
   * Inserts or updates a transaction keyed on the full unique triple
   * { trx_hash, wallet_from, wallet_to }. Immutable identity fields are only
   * set on insert; mutable fields (status, amount, fee, notes, links) are
   * always set. Used to record an order intent and then evolve its status in
   * place across the order lifecycle.
   *
   * Non-throwing: a concurrent insert can race to an E11000 duplicate-key
   * error, in which case we fall back to a plain update of the existing row.
   */
  upsertTransaction: async (transactionData: TransactionData): Promise<void> => {
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
      user_notes,
      polymarket_order_id,
      polymarket_purchase_id,
      polymarket_market_slug,
      polymarket_size,
      polymarket_bridge_tx_hash,
      polymarket_bridge_amount,
      polymarket_bridge_token
    } = transactionData;

    const key = { trx_hash: tx, wallet_from: walletFrom, wallet_to: walletTo };
    const mutable: Record<string, unknown> = { status, amount, fee, user_notes: user_notes || '' };
    if (polymarket_order_id !== undefined) mutable.polymarket_order_id = polymarket_order_id;
    if (polymarket_purchase_id !== undefined)
      mutable.polymarket_purchase_id = polymarket_purchase_id;
    if (polymarket_market_slug !== undefined)
      mutable.polymarket_market_slug = polymarket_market_slug;
    if (polymarket_size !== undefined) mutable.polymarket_size = polymarket_size;
    if (polymarket_bridge_tx_hash !== undefined)
      mutable.polymarket_bridge_tx_hash = polymarket_bridge_tx_hash;
    if (polymarket_bridge_amount !== undefined)
      mutable.polymarket_bridge_amount = polymarket_bridge_amount;
    if (polymarket_bridge_token !== undefined)
      mutable.polymarket_bridge_token = polymarket_bridge_token;

    const onInsert = { type, token, chain_id, date: date || new Date() };

    try {
      await Transaction.findOneAndUpdate(
        key,
        { $set: mutable, $setOnInsert: onInsert },
        { upsert: true, new: true }
      );
    } catch (error: unknown) {
      // Concurrent insert raced us to the unique key — fall back to update.
      if ((error as { code?: number }).code === 11000) {
        try {
          await Transaction.findOneAndUpdate(key, { $set: mutable });
          return;
        } catch (retryError: unknown) {
          Logger.error(
            'upsertTransaction',
            `Error updating transaction ${tx} after duplicate-key race:`,
            (retryError as Error).message
          );
          return;
        }
      }
      Logger.error(
        'upsertTransaction',
        `Error upserting transaction ${tx}:`,
        (error as Error).message
      );
    }
  },

  /**
   * Updates the status (and optional extra fields) of a transaction by hash.
   * Non-throwing.
   */
  updateTransactionStatus: async (
    trxHash: string,
    status: string,
    patch: Partial<{
      amount: number;
      fee: number;
      user_notes: string;
      polymarket_order_id: string;
      polymarket_size: number;
    }> = {}
  ): Promise<void> => {
    try {
      await Transaction.findOneAndUpdate({ trx_hash: trxHash }, { $set: { status, ...patch } });
    } catch (error: unknown) {
      Logger.error(
        'updateTransactionStatus',
        `Error updating status for transaction ${trxHash}:`,
        (error as Error).message
      );
    }
  },

  /**
   * Attaches the resolved market info to an order transaction (background
   * enrichment). The slug is always set; the readable label only replaces the
   * note while it is still the generic placeholder, so it never clobbers an
   * error note written by a concurrent failure. Non-throwing.
   */
  setOrderMarket: async (
    trxHash: string,
    label: string,
    slug: string,
    placeholderNote: string
  ): Promise<void> => {
    try {
      await Transaction.updateOne(
        { trx_hash: trxHash },
        { $set: { polymarket_market_slug: slug } }
      );
      if (label) {
        await Transaction.updateOne(
          { trx_hash: trxHash, user_notes: placeholderNote },
          { $set: { user_notes: label } }
        );
      }
    } catch (error: unknown) {
      Logger.error(
        'setOrderMarket',
        `Error setting market for transaction ${trxHash}:`,
        (error as Error).message
      );
    }
  },

  /**
   * Updates a transaction located by its linked CLOB order id. Used by the
   * order reconciliation path (syncOpenOrders) which knows the CLOB order id
   * but not the synthetic trx_hash. Non-throwing.
   */
  updateStatusByPolymarketOrderId: async (
    orderId: string,
    status: string,
    patch: Partial<{ amount: number; polymarket_size: number }> = {}
  ): Promise<void> => {
    try {
      await Transaction.findOneAndUpdate(
        { polymarket_order_id: orderId },
        { $set: { status, ...patch } }
      );
    } catch (error: unknown) {
      Logger.error(
        'updateStatusByPolymarketOrderId',
        `Error updating transaction for order ${orderId}:`,
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
  },

  /**
   * Patches arbitrary fields on a transaction record by hash. Used for post-bridge
   * or post-withdrawal corrections (e.g. updating token/amount to the Scroll-side
   * values after the actual transfer is known). Non-throwing.
   */
  patchTransactionFields: async (
    trxHash: string,
    patch: Partial<{
      token: string;
      amount: number;
      polymarket_size: number;
      user_notes: string;
      polymarket_bridge_tx_hash: string;
      polymarket_bridge_amount: number;
      polymarket_bridge_token: string;
    }>
  ): Promise<void> => {
    try {
      await Transaction.findOneAndUpdate({ trx_hash: trxHash }, { $set: patch });
    } catch (error: unknown) {
      Logger.error(
        'patchTransactionFields',
        `Error patching transaction ${trxHash}:`,
        (error as Error).message
      );
    }
  },

  async getByHashInsensitive(txHash: string) {
    return Transaction.findOne({
      trx_hash: { $regex: new RegExp(`^${txHash}$`, 'i') }
    }).lean();
  },

  /**
   * Deletes a transaction record by hash. Used to discard a synthetic order row
   * that has been superseded by another record (e.g. a boundary-price SELL that
   * was fulfilled as a CTF claim — the claim row is the source of truth, so the
   * stale SELL row would only show as a phantom failure). Non-throwing.
   */
  deleteByHash: async (trxHash: string): Promise<void> => {
    try {
      await Transaction.deleteOne({ trx_hash: trxHash });
    } catch (error: unknown) {
      Logger.error(
        'deleteByHash',
        `Error deleting transaction ${trxHash}:`,
        (error as Error).message
      );
    }
  }
};
