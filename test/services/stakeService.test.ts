/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from 'ethers';
import { it, vi, expect, describe, beforeEach } from 'vitest';

import * as userService from '../../src/services/userService';
import { processStakeRequest } from '../../src/services/stakeService';
import * as userOpService from '../../src/services/web3/userOpService';
import * as blockchainService from '../../src/services/blockchainService';
import { mongoUserService } from '../../src/services/mongo/mongoUserService';
import * as paymasterService from '../../src/services/web3/paymasterService';
import * as contractSetupService from '../../src/services/web3/contractSetupService';
import { mongoBlockchainService } from '../../src/services/mongo/mongoBlockchainService';

// Mock dependencies
vi.mock('../../src/services/mongo/mongoUserService');
vi.mock('../../src/services/mongo/mongoTransactionService');
vi.mock('../../src/helpers/loggerHelper');

// Mock helpers from other services that are not default exports
vi.mock('../../src/services/userService', () => ({
  openOperation: vi.fn(),
  closeOperation: vi.fn(),
  getUserWalletByChainId: vi.fn(),
  hasUserAnyOperationInProgress: vi.fn()
}));

vi.mock('../../src/services/mongo/mongoBlockchainService', () => ({
  mongoBlockchainService: {
    getNetworkConfig: vi.fn()
  }
}));

vi.mock('../../src/services/blockchainService', () => ({
  checkBlockchainConditions: vi.fn()
}));

vi.mock('../../src/services/web3/userOpService', () => ({
  executeUserOperationWithRetry: vi.fn(),
  createExecuteCallData: vi.fn()
}));

vi.mock('../../src/services/web3/paymasterService', () => ({
  getPaymasterEntryPointDepositValue: vi.fn(),
  logPaymasterEntryPointDeposit: vi.fn()
}));

vi.mock('../../src/services/web3/contractSetupService', () => ({
  setupERC20: vi.fn()
}));

// Mock ethers
const mockEncodeFunctionData = vi.fn().mockReturnValue('0xEncodedData');
const mockAsset = vi.fn().mockResolvedValue('0xUSX');
vi.mock('ethers', async () => {
  const actual = await vi.importActual<any>('ethers');
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      providers: {
        ...actual.ethers.providers,
        JsonRpcProvider: vi.fn()
      },
      Contract: vi.fn().mockImplementation(() => ({
        asset: mockAsset,
        decimals: vi.fn().mockResolvedValue(18),
        interface: {
          encodeFunctionData: mockEncodeFunctionData
        }
      })),
      utils: {
        ...actual.ethers.utils,
        Interface: vi.fn().mockImplementation(() => ({
          encodeFunctionData: mockEncodeFunctionData
        })),
        parseUnits: actual.ethers.utils.parseUnits
      },
      BigNumber: actual.ethers.BigNumber,
      constants: actual.ethers.constants
    }
  };
});

describe('processStakeRequest', () => {
  const mockUser = {
    phone_number: '1234567890',
    wallets: [{ chain_id: 123, wallet_proxy: '0xProxy' }]
  };
  const mockWallet = { chain_id: 123, wallet_proxy: '0xProxy' };
  const mockNetworkConfig = {
    rpcBundler: 'http://bundler',
    contracts: { paymasterAddress: '0xPaymaster', entryPoint: '0xEntryPoint' },
    gas: { operations: { stake: {}, unstake: {} } }
  };
  const mockCheckResult = {
    success: true,
    entryPointContract: { address: '0xEntryPoint' },
    setupContractsResult: {
      userPrincipal: {},
      chatterPay: { interface: { encodeFunctionData: mockEncodeFunctionData } },
      proxy: { proxyAddress: '0xProxy' },
      provider: {}
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy path mocks
    (mongoUserService.getUser as any).mockResolvedValue(mockUser);
    (userService.getUserWalletByChainId as any).mockReturnValue(mockWallet);
    (userService.hasUserAnyOperationInProgress as any).mockReturnValue(false);
    (mongoBlockchainService.getNetworkConfig as any).mockResolvedValue(mockNetworkConfig);
    (blockchainService.checkBlockchainConditions as any).mockResolvedValue(mockCheckResult);
    (paymasterService.getPaymasterEntryPointDepositValue as any).mockResolvedValue(
      ethers.BigNumber.from(100)
    );
    (userOpService.executeUserOperationWithRetry as any).mockResolvedValue({
      success: true,
      transactionHash: '0xTxHash'
    });
    (contractSetupService.setupERC20 as any).mockResolvedValue({
      decimals: vi.fn().mockResolvedValue(18),
      allowance: vi.fn().mockResolvedValue(ethers.BigNumber.from(10).pow(20)) // High allowance
    });
  });

  it('should successfully process a stake request', async () => {
    const result = await processStakeRequest('user1', '10', 123, 'stake', 'USX', 'logKey');

    expect(result.result).toBe(true);
    expect(result.transactionHash).toBe('0xTxHash');
    expect(userService.openOperation).toHaveBeenCalled();
    expect(userService.closeOperation).toHaveBeenCalled();
    expect(userOpService.executeUserOperationWithRetry).toHaveBeenCalled();
  });

  it('should return error for unsupported token', async () => {
    const result = await processStakeRequest('user1', '10', 123, 'stake', 'INVALID', 'logKey');
    expect(result.result).toBe(false);
    expect(result.message).toContain('Staking not supported');
  });

  it('should return error if user not found', async () => {
    (mongoUserService.getUser as any).mockResolvedValue(null);
    const result = await processStakeRequest('user1', '10', 123, 'stake', 'USX', 'logKey');
    expect(result.result).toBe(false);
    expect(result.message).toBe('User not found');
  });
});
