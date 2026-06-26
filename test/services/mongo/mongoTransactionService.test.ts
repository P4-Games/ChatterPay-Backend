import { beforeEach, describe, expect, it } from 'vitest';

import Transaction from '../../../src/models/transactionModel';
import { mongoTransactionService } from '../../../src/services/mongo/mongoTransactionService';
import type { TransactionData } from '../../../src/types/commonType';

const baseTx = (overrides: Partial<TransactionData> = {}): TransactionData => ({
  tx: 'pm-order-abc',
  walletFrom: '0xSafe',
  walletTo: 'polymarket',
  amount: 10,
  fee: 0,
  token: 'USDC',
  type: 'polymarket_buy',
  status: 'submitted',
  chain_id: 137,
  ...overrides
});

describe('mongoTransactionService.upsertTransaction', () => {
  beforeEach(async () => {
    await Transaction.syncIndexes();
  });

  it('inserts a new row and then updates it in place (one doc, status mutated)', async () => {
    await mongoTransactionService.upsertTransaction(baseTx({ status: 'submitted' }));
    await mongoTransactionService.upsertTransaction(baseTx({ status: 'in_progress' }));
    await mongoTransactionService.upsertTransaction(
      baseTx({ status: 'completed', amount: 12, polymarket_order_id: '0xClobId' })
    );

    const docs = await Transaction.find({ trx_hash: 'pm-order-abc' }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe('completed');
    expect(docs[0].amount).toBe(12);
    expect(docs[0].polymarket_order_id).toBe('0xClobId');
    // Immutable identity fields preserved from insert
    expect(docs[0].type).toBe('polymarket_buy');
  });

  it('does not throw and yields a single doc under concurrent same-key upserts', async () => {
    await Promise.all([
      mongoTransactionService.upsertTransaction(baseTx({ status: 'submitted' })),
      mongoTransactionService.upsertTransaction(baseTx({ status: 'in_progress' })),
      mongoTransactionService.upsertTransaction(baseTx({ status: 'completed' }))
    ]);

    const docs = await Transaction.find({ trx_hash: 'pm-order-abc' }).lean();
    expect(docs).toHaveLength(1);
  });

  it('keeps separate rows when the unique triple differs (different trx_hash)', async () => {
    await mongoTransactionService.upsertTransaction(baseTx({ tx: 'pm-order-a' }));
    await mongoTransactionService.upsertTransaction(baseTx({ tx: 'pm-order-b' }));

    const count = await Transaction.countDocuments({});
    expect(count).toBe(2);
  });
});

describe('mongoTransactionService.updateTransactionStatus', () => {
  it('updates status and patch fields by trx_hash', async () => {
    await mongoTransactionService.upsertTransaction(baseTx({ status: 'in_progress' }));
    await mongoTransactionService.updateTransactionStatus('pm-order-abc', 'failed', {
      user_notes: 'boom'
    });

    const doc = await Transaction.findOne({ trx_hash: 'pm-order-abc' }).lean();
    expect(doc?.status).toBe('failed');
    expect(doc?.user_notes).toBe('boom');
  });

  it('is a no-op (non-throwing) when the transaction does not exist', async () => {
    await expect(
      mongoTransactionService.updateTransactionStatus('missing', 'failed')
    ).resolves.toBeUndefined();
  });
});

describe('mongoTransactionService.updateStatusByPolymarketOrderId', () => {
  it('updates the row located by its linked CLOB order id', async () => {
    await mongoTransactionService.upsertTransaction(
      baseTx({ status: 'completed', polymarket_order_id: '0xClobId' })
    );

    await mongoTransactionService.updateStatusByPolymarketOrderId('0xClobId', 'partial', {
      amount: 5
    });

    const doc = await Transaction.findOne({ polymarket_order_id: '0xClobId' }).lean();
    expect(doc?.status).toBe('partial');
    expect(doc?.amount).toBe(5);
  });
});
