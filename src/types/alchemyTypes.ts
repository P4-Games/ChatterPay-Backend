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
  nonce?: string;
  blockHash: string;
  blockNumber: string;
  transactionIndex?: string;
  from: string;
  to: string | null;
  value: string;
  gas?: string;
  gasPrice?: string;
  input?: string;
}

/**
 * New Alchemy "Address Activity" item
 */
export interface AlchemyAddressActivity {
  asset: string;
  blockNum: string;
  category: string;
  fromAddress: string;
  toAddress: string;
  hash: string;
  value: number | string;
  log?: AlchemyLog;
  rawContract?: {
    address: string;
    decimals: number;
    rawValue: string;
  };
}

/**
 * Unified webhook payload supporting both legacy and new formats
 */
export interface AlchemyWebhookPayload {
  webhookId: string;
  id: string;
  createdAt: string;
  // Alchemy now includes ADDRESS_ACTIVITY as a type
  type: 'GRAPHQL' | 'MINED_TRANSACTION' | 'DROPPED_TRANSACTION' | 'ADDRESS_ACTIVITY';
  event: {
    // Old format
    data?: {
      block: {
        hash: string;
        number: string;
        timestamp: string;
      };
      logs?: AlchemyLog[];
      transaction?: AlchemyTransaction;
    };
    // New format
    activity?: AlchemyAddressActivity[];
    network?: string;
  };
}

export interface ExternalDepositEvent {
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
