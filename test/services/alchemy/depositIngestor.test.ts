import { describe, it, expect, beforeEach } from 'vitest';
import { DepositIngestor, AlchemyWebhookPayload, AlchemyLog, AlchemyTransaction } from '../../../src/services/alchemy/depositIngestor';
import { ERC20_TRANSFER_SIG } from '../../../src/config/constants';

describe('DepositIngestor', () => {
  let ingestor: DepositIngestor;

  beforeEach(() => {
    ingestor = new DepositIngestor(421614); // Arbitrum Sepolia
  });

  describe('processWebhookPayload', () => {
    it('should process ERC-20 transfer logs', async () => {
      const mockLog: AlchemyLog = {
        address: '0xa0b86a33e6441e58ba7d4d41e6e8b2f1c3f4f5e6',
        topics: [
          ERC20_TRANSFER_SIG,
          '0x000000000000000000000000sender1234567890123456789012345678901234',
          '0x000000000000000000000000recipient1234567890123456789012345678901'
        ],
        data: '0x00000000000000000000000000000000000000000000000000de0b6b3a7640000', // 1e18
        blockNumber: '0x123456',
        transactionHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        transactionIndex: '0x0',
        blockHash: '0xblockhash',
        logIndex: '0x0',
        removed: false
      };

      const payload: AlchemyWebhookPayload = {
        webhookId: 'webhook-123',
        id: 'event-123',
        createdAt: '2023-01-01T00:00:00Z',
        type: 'GRAPHQL',
        event: {
          data: {
            block: {
              hash: '0xblockhash',
              number: '0x123456',
              timestamp: '1672531200'
            },
            logs: [mockLog]
          }
        }
      };

      const events = await ingestor.processWebhookPayload(payload);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        chainId: 421614,
        txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        logIndex: 0,
        from: '0xsender1234567890123456789012345678901234',
        to: '0xrecipient1234567890123456789012345678901',
        token: '0xa0b86a33e6441e58ba7d4d41e6e8b2f1c3f4f5e6',
        value: '1000000000000000000',
        decimals: 18,
        provider: 'alchemy',
        status: 'observed'
      });
    });

    it('should process ETH transactions', async () => {
      const mockTransaction: AlchemyTransaction = {
        hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        nonce: '0x1',
        blockHash: '0xblockhash',
        blockNumber: '0x123456',
        transactionIndex: '0x0',
        from: '0xsender1234567890123456789012345678901234567890',
        to: '0xrecipient1234567890123456789012345678901234567890',
        value: '0xde0b6b3a7640000', // 1 ETH
        gas: '0x5208',
        gasPrice: '0x3b9aca00',
        input: '0x'
      };

      const payload: AlchemyWebhookPayload = {
        webhookId: 'webhook-123',
        id: 'event-123',
        createdAt: '2023-01-01T00:00:00Z',
        type: 'MINED_TRANSACTION',
        event: {
          data: {
            block: {
              hash: '0xblockhash',
              number: '0x123456',
              timestamp: '1672531200'
            },
            transaction: mockTransaction
          }
        }
      };

      const events = await ingestor.processWebhookPayload(payload);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        chainId: 421614,
        txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        logIndex: 0,
        from: '0xsender1234567890123456789012345678901234567890',
        to: '0xrecipient1234567890123456789012345678901234567890',
        token: null,
        value: '1000000000000000000',
        decimals: 18,
        provider: 'alchemy',
        status: 'observed'
      });
    });

    it('should ignore non-Transfer events', async () => {
      const mockLog: AlchemyLog = {
        address: '0xa0b86a33e6441e58ba7d4d41e6e8b2f1c3f4f5e6',
        topics: [
          '0x1234567890123456789012345678901234567890123456789012345678901234', // Not Transfer signature
          '0x000000000000000000000000sender1234567890123456789012345678901234',
          '0x000000000000000000000000recipient1234567890123456789012345678901'
        ],
        data: '0x00000000000000000000000000000000000000000000000000de0b6b3a7640000',
        blockNumber: '0x123456',
        transactionHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        transactionIndex: '0x0',
        blockHash: '0xblockhash',
        logIndex: '0x0',
        removed: false
      };

      const payload: AlchemyWebhookPayload = {
        webhookId: 'webhook-123',
        id: 'event-123',
        createdAt: '2023-01-01T00:00:00Z',
        type: 'GRAPHQL',
        event: {
          data: {
            block: {
              hash: '0xblockhash',
              number: '0x123456',
              timestamp: '1672531200'
            },
            logs: [mockLog]
          }
        }
      };

      const events = await ingestor.processWebhookPayload(payload);
      expect(events).toHaveLength(0);
    });

    it('should ignore zero-value ETH transactions', async () => {
      const mockTransaction: AlchemyTransaction = {
        hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        nonce: '0x1',
        blockHash: '0xblockhash',
        blockNumber: '0x123456',
        transactionIndex: '0x0',
        from: '0xsender1234567890123456789012345678901234567890',
        to: '0xrecipient1234567890123456789012345678901234567890',
        value: '0x0', // Zero value
        gas: '0x5208',
        gasPrice: '0x3b9aca00',
        input: '0x'
      };

      const payload: AlchemyWebhookPayload = {
        webhookId: 'webhook-123',
        id: 'event-123',
        createdAt: '2023-01-01T00:00:00Z',
        type: 'MINED_TRANSACTION',
        event: {
          data: {
            block: {
              hash: '0xblockhash',
              number: '0x123456',
              timestamp: '1672531200'
            },
            transaction: mockTransaction
          }
        }
      };

      const events = await ingestor.processWebhookPayload(payload);
      expect(events).toHaveLength(0);
    });

    it('should handle empty payload gracefully', async () => {
      const payload: AlchemyWebhookPayload = {
        webhookId: 'webhook-123',
        id: 'event-123',
        createdAt: '2023-01-01T00:00:00Z',
        type: 'GRAPHQL',
        event: {
          data: {
            block: {
              hash: '0xblockhash',
              number: '0x123456',
              timestamp: '1672531200'
            }
          }
        }
      };

      const events = await ingestor.processWebhookPayload(payload);
      expect(events).toHaveLength(0);
    });
  });
});
