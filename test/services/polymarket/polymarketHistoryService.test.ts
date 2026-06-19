import { describe, expect, it, vi } from 'vitest';

import Transaction from '../../../src/models/transactionModel';

// Stub the market lookup so recordOrderIntent doesn't hit the network and we can
// assert the resolved market label/slug deterministically.
vi.mock('../../../src/services/polymarket/polymarketMarketService', () => ({
  getMarketByClobTokenId: vi.fn(async () => ({
    question: 'Will it rain tomorrow?',
    slug: 'will-it-rain-tomorrow',
    clobTokenIds: '["tok-yes","tok-no"]',
    outcomes: '["Yes","No"]'
  })),
  getOutcomeForToken: vi.fn(() => 'Yes')
}));

import {
  enrichOrderMarket,
  mapClobStatusToTxStatus,
  markOrderInProgress,
  orderTrxHash,
  POLYMARKET_COUNTERPARTY,
  recordClaim,
  recordOrderCancelled,
  recordOrderFailed,
  recordOrderIntent,
  recordOrderPlaced
} from '../../../src/services/polymarket/polymarketHistoryService';

const PROXY = '0xScrollProxy';

describe('polymarketHistoryService — direction by side', () => {
  it('records a BUY intent as safe -> polymarket (OUT)', async () => {
    await recordOrderIntent({
      side: 'BUY',
      refId: 'buy1',
      userProxy: PROXY,
      price: 0.5,
      size: 10,
      tokenId: 'tok-yes',
      logKey: 'test'
    });

    const doc = await Transaction.findOne({ trx_hash: orderTrxHash('buy1') }).lean();
    expect(doc?.type).toBe('polymarket_buy');
    expect(doc?.wallet_from).toBe(PROXY);
    expect(doc?.wallet_to).toBe(POLYMARKET_COUNTERPARTY);
    expect(doc?.status).toBe('submitted');
    expect(doc?.amount).toBe(5);

    // The market name is resolved in the background (non-blocking on the order
    // path). Await it deterministically here, then assert the note + slug.
    await enrichOrderMarket(orderTrxHash('buy1'), 'BUY', 'tok-yes', 'test');
    const enriched = await Transaction.findOne({ trx_hash: orderTrxHash('buy1') }).lean();
    expect(enriched?.user_notes).toBe('BUY: Will it rain tomorrow? (Yes)');
    expect(enriched?.polymarket_market_slug).toBe('will-it-rain-tomorrow');
  });

  it('records a SELL intent as polymarket -> safe (IN)', async () => {
    await recordOrderIntent({
      side: 'SELL',
      refId: 'sell1',
      userProxy: PROXY,
      price: 0.4,
      size: 10,
      tokenId: 'tok-yes',
      logKey: 'test'
    });

    const doc = await Transaction.findOne({ trx_hash: orderTrxHash('sell1') }).lean();
    expect(doc?.type).toBe('polymarket_sell');
    expect(doc?.wallet_from).toBe(POLYMARKET_COUNTERPARTY);
    expect(doc?.wallet_to).toBe(PROXY);
  });
});

describe('polymarketHistoryService — order lifecycle on one record', () => {
  it('evolves submitted -> in_progress -> completed and rewrites amount to effective size', async () => {
    const trx = await recordOrderIntent({
      side: 'BUY',
      refId: 'life1',
      userProxy: PROXY,
      price: 0.5,
      size: 10, // requested → amount 5
      tokenId: 'tok-yes',
      logKey: 'test'
    });

    await markOrderInProgress(trx);
    let doc = await Transaction.findOne({ trx_hash: trx }).lean();
    expect(doc?.status).toBe('in_progress');

    await recordOrderPlaced(trx, { orderId: '0xOrder', price: 0.5, effectiveSize: 8 });
    doc = await Transaction.findOne({ trx_hash: trx }).lean();

    const all = await Transaction.find({ trx_hash: trx }).lean();
    expect(all).toHaveLength(1); // still one record
    expect(doc?.status).toBe('completed');
    expect(doc?.amount).toBe(4); // 0.5 * 8 effective size, not the requested 5
    expect(doc?.polymarket_order_id).toBe('0xOrder');
  });

  it('marks a failed attempt', async () => {
    const trx = await recordOrderIntent({
      side: 'BUY',
      refId: 'fail1',
      userProxy: PROXY,
      price: 0.5,
      size: 10,
      tokenId: 'tok-yes',
      logKey: 'test'
    });
    await recordOrderFailed(trx, 'insufficient balance');

    const doc = await Transaction.findOne({ trx_hash: trx }).lean();
    expect(doc?.status).toBe('failed');
    expect(doc?.user_notes).toContain('insufficient balance');
  });

  it('marks a cancelled attempt (SELL superseded by claim)', async () => {
    const trx = await recordOrderIntent({
      side: 'SELL',
      refId: 'cancel1',
      userProxy: PROXY,
      price: 0.99,
      size: 10,
      tokenId: 'tok-yes',
      logKey: 'test'
    });
    await recordOrderCancelled(trx, 'superseded by claim');

    const doc = await Transaction.findOne({ trx_hash: trx }).lean();
    expect(doc?.status).toBe('cancelled');
  });
});

describe('polymarketHistoryService — claim', () => {
  it('records a claim with its real on-chain txHash (IN)', async () => {
    await recordClaim({ userProxy: PROXY, amount: 42, txHash: '0xClaimTx' });

    const doc = await Transaction.findOne({ trx_hash: '0xClaimTx' }).lean();
    expect(doc?.type).toBe('polymarket_claim');
    expect(doc?.wallet_from).toBe(POLYMARKET_COUNTERPARTY);
    expect(doc?.wallet_to).toBe(PROXY);
    expect(doc?.amount).toBe(42);
    expect(doc?.status).toBe('completed');
  });
});

describe('polymarketHistoryService.mapClobStatusToTxStatus', () => {
  it('maps CLOB order states to history statuses', () => {
    expect(mapClobStatusToTxStatus('filled')).toBe('completed');
    expect(mapClobStatusToTxStatus('partial')).toBe('partial');
    expect(mapClobStatusToTxStatus('cancelled')).toBe('cancelled');
    expect(mapClobStatusToTxStatus('failed')).toBe('failed');
    expect(mapClobStatusToTxStatus('weird')).toBe('weird');
  });
});
