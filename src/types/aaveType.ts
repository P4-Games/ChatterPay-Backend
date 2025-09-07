import { ethers } from 'ethers';

export interface AaveReserveValidationResult {
  supported: boolean;
  aTokenAddress?: string;
}

export interface AaveTokenBalanceInfo {
  balance: string;
  rawBalance: ethers.BigNumber;
  decimals: number;
  symbol: string;
}

export interface AaveSupplyInfo {
  supplyAPY: string;
  aTokenBalance: string;
  aTokenSymbol: string;
}

export interface AaveTokenInfo {
  success: boolean;
  tokenBalance?: AaveTokenBalanceInfo;
  supplyInfo?: AaveSupplyInfo;
  error?: string;
}

export type AaveWithdrawResult = {
  success: boolean;
  txHash?: string;
  amountWithdrawn?: string;
  error?: string;
};
