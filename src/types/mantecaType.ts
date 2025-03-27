export interface MantecaBankAccount {
  description: string;
  cbu: string;
  bankCode: string;
  bankName: string;
  accountType: string;
}

export interface MantecaUserBalance {
  fiat: {
    ARS: { amount: string };
    [key: string]: { amount: string };
  };
  crypto: {
    WLD: { amount: string; weiAmount: string };
    USDC: { amount: string; weiAmount: string };
    [key: string]: { amount: string; weiAmount?: string };
  };
  locked: {
    fiat: {
      ARS: { amount: string };
      [key: string]: { amount: string };
    };
    crypto: {
      [key: string]: unknown;
    };
  };
}

export interface MantecaUser {
  numberId: string;
  userId: string;
  email: string;
  cuit: string;
  country: string;
  civilState: string;
  name: string;
  creationTime: string;
  bankAccounts: Record<string, MantecaBankAccount[]>;
  balance: MantecaUserBalance;
  addresses: Record<string, string>;
  exchangeCountry: string;
  sessionId: string;
  status: string;
  externalId: string;
}

export interface MantecaUserCreate {
  name: string;
  email: string;
  legalId: string;
  phoneNumber: string;
  country: string;
  civilState: string;
  externalId: string;
  address: string;
  isPep: boolean;
  isFatca: boolean;
  isUif: false;
}

export interface MantecaFinanceBalance {
  fiat: Record<string, { human: string }>;
  crypto: Record<string, { human: string }>;
}

export interface MantecaCryptoBalance {
  [key: string]: {
    wei: string;
    human: string;
  };
}

export interface MantecaFiatBalance {
  [key: string]: {
    human: string;
  };
}

export interface MantecaBalance {
  crypto: MantecaCryptoBalance;
  fiat: MantecaFiatBalance;
}

export interface MantecaCompanyDebt {
  crypto: MantecaCryptoBalance;
  fiat: MantecaFiatBalance;
}

export interface MantecaCompanyCredit {
  crypto: MantecaCryptoBalance;
  fiat: MantecaFiatBalance;
}

export interface MantecaPriceVariation {
  realtime: string;
  daily: string;
}

export interface MantecaPrice {
  coin: string;
  timestamp: string;
  buy: string;
  sell: string;
  variation: MantecaPriceVariation;
}

export interface MantecaHistoricalPrice {
  coin: string;
  buy: string;
  sell: string;
  timestamp: string;
}

export interface MantecaOrder {
  numberId: string;
  user: {
    userId: string;
  };
  coin: string;
  operation: string;
  coinValue: string;
  amount: string;
  status: string;
  coinValueArs: string;
  creationTime: string;
  fee: number | null;
}

export interface MantecaLock {
  code: string;
  price: string;
  expires: string;
}

export interface MantecaPair {
  coin: string;
  decimals: number;
  minSize: string;
}

export interface MantecaRampOn {
  id: string;
  externalId: string;
  numberId: string;
  companyId: string;
  userId: string;
  userNumberId: string;
  userExternalId: string;
  status: string;
  type: string;
  details: {
    depositAddress: string;
    withdrawCostInAgainst: string;
    withdrawCostInAsset: string;
  };
  currentStage: number;
  stages: {
    [key: string]: {
      stageType: string;
      asset: string;
      tresholdAmount: string;
      expireAt: string;
      side?: string;
      type?: string;
      price?: string;
      priceCode?: string;
      disallowDebt?: boolean;
      network?: string;
      amount?: string;
      to?: string;
    };
  };
  creationTime: string;
  updatedAt: string;
}

export interface MantecaRampOff {
  id: string;
  numberId: string;
  externalId: string;
  companyId: string;
  userId: string;
  userNumberId: string;
  userExternalId: string;
  sessionId: string;
  status: string;
  type: string;
  details: {
    depositAddress: string;
    depositAvailableNetworks: string[];
    withdrawCostInAgainst: string;
    withdrawCostInAsset: string;
  };
  currentStage: number;
  stages: {
    [key: string]: {
      stageType: string;
      asset: string;
      amount?: string;
      network?: string;
      to?: string;
    };
  };
}

export interface MantecaTransaction {
  from: string;
  to: string;
  amount: string;
  hash: string;
  numberId: string;
  creationTime: string;
  chain: string;
  type: string;
  status: string;
  coin: string;
  description: string;
  cost: string;
  user: {
    name: string;
    cuit: string;
    numberId: string;
  };
}

export interface MantecaTransactionLock {
  gasUsed: string;
  feeInUSD: string;
  feeInNative: string;
  priceOfNative: string;
  wait: string;
  feeInRequestedCoin: string;
  code: string;
  expires: string;
}

export interface MantecaTransactionWithdraw {
  from: string;
  to: string;
  amount: string;
  hash: string;
  numberId: string;
  creationTime: string;
  chain: string;
  type: string;
  status: string;
  coin: string;
  network: string;
  cost: string;
  user: {
    id: string;
    name: string;
    cuit: string;
    numberId: string;
    externalId: string;
  };
}

export interface MantecaSupportedAssets {
  [chain: string]: {
    deposit: string[];
    withdraw: string[];
  };
}

export type MantecaOperationSide = 'BUY' | 'SELL';

export interface MantecaWidgetOnboarding {
  userExternalId: string;
  sessionId: string;
  returnUrl: string;
  failureUrl: string;
  options: {
    endOnOperation: boolean;
    endOnOperationWaiting: boolean;
    side: MantecaOperationSide;
    asset: string;
    against: string;
    assetAmount?: string;
    againstAmount?: string;
    withdrawAddress: string;
    withdrawNetwork: string;
  };
}
