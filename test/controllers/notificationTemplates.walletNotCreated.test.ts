import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const templateMessages = {
  wallet_not_created: {
    en: "A wallet linked to your phone number hasn't been created yet. Please create one to continue with the operation.",
    es: 'A?n no se cre? una wallet vinculada a tu n?mero de tel?fono. Por favor, cre? una para continuar con la operaci?n.',
    pt: 'Uma carteira vinculada ao seu n?mero de telefone ainda n?o foi criada. Por favor, crie uma para continuar com a opera??o.'
  },
  operation_in_progress: {
    en: 'The operation is being processed. We will notify you once it is completed or if any issues arise.',
    es: 'La operaci?n est? siendo procesada. Te notificaremos una vez que se complete o si surge alg?n inconveniente.',
    pt: 'A opera??o est? sendo processada. Avisaremos voc? assim que for conclu?da ou se ocorrer algum problema.'
  }
} as const;

type Lang = 'en' | 'es' | 'pt';

const languageForPhone = (phone: string): Lang => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('54')) return 'es';
  if (digits.startsWith('55')) return 'pt';
  if (digits.startsWith('1')) return 'en';
  if (digits.startsWith('33')) return 'en'; // default
  return 'en';
};

const mockGetNotificationTemplate = vi.hoisted(() => vi.fn());
const mockReturnSuccessResponse = vi.hoisted(() => vi.fn());
const mockReturnErrorResponse = vi.hoisted(() => vi.fn());
const mockReturnErrorResponseAsSuccess = vi.hoisted(() => vi.fn());

const mockGetUser = vi.hoisted(() => vi.fn());
const mockGetUserWalletByChainId = vi.hoisted(() => vi.fn());
const mockGetUserWallet = vi.hoisted(() => vi.fn());
const mockGetUserByTelegramId = vi.hoisted(() => vi.fn());
const mockHasPhoneAnyOperationInProgress = vi.hoisted(() => vi.fn());
const mockHasUserAnyOperationInProgress = vi.hoisted(() => vi.fn());
const mockOpenOperation = vi.hoisted(() => vi.fn());
const mockCloseOperation = vi.hoisted(() => vi.fn());
const mockGetOrCreateUser = vi.hoisted(() => vi.fn());

const mockGetSwapTokensData = vi.hoisted(() => vi.fn());
const mockGetTokenData = vi.hoisted(() => vi.fn());
const mockUserReachedOperationLimit = vi.hoisted(() => vi.fn());
const mockUserWithinTokenOperationLimits = vi.hoisted(() => vi.fn());

const mockReferralService = vi.hoisted(() => ({
  getOrGenerateReferralCode: vi.fn(),
  getReferralByCode: vi.fn(),
  getReferralCodeWithUsageCount: vi.fn(),
  submitReferrerCode: vi.fn()
}));

vi.mock('../../src/helpers/requestHelper', () => ({
  returnSuccessResponse: mockReturnSuccessResponse,
  returnErrorResponse: mockReturnErrorResponse,
  returnErrorResponseAsSuccess: mockReturnErrorResponseAsSuccess
}));

vi.mock('../../src/helpers/validationHelper', () => ({
  isValidPhoneNumber: (value: string) => /\d{8,15}/.test(value.replace(/\D/g, '')),
  isValidEthereumWallet: (value: string) => value.startsWith('0x') && value.length >= 10,
  isValidEthereumWalletAddress: (value: string) => value.startsWith('0x') && value.length >= 10,
  isValidEthereumWalletPublicKey: (value: string) => value.startsWith('0x') && value.length >= 10,
  isValidEthereumWalletPrivateKey: (value: string) => value.startsWith('0x') && value.length >= 10,
  isValidEthereumWalletSignature: (_value: string) => true,
  isValidEthereumWalletTransactionHash: (_value: string) => true,
  isValidEthereumWalletBlockHash: (_value: string) => true,
  isValidEthereumWalletBlockNumber: (_value: string) => true,
  isValidEthereumWalletBlockTag: (_value: string) => true,
  isValidEthereumWalletBlock: (_value: string) => true,
  isValidEthereumWalletBlockWithTransactions: (_value: string) => true,
  isValidEthereumWalletTransaction: (_value: string) => true,
  isValidEthereumWalletTransactionReceipt: (_value: string) => true,
  isValidEthereumWalletTransactionResponse: (_value: string) => true,
  isValidEthereumWalletTransactionRequest: (_value: string) => true,
  isValidEthereumWalletTransactionRequestOptions: (_value: string) => true,
  isValidEthereumWalletTransactionRequestOverride: (_value: string) => true,
  isValidEthereumWalletTransactionRequestOverrideWithGas: (_value: string) => true,
  isValidEthereumWalletTransactionRequestOverrideWithGasPrice: (_value: string) => true,
  isValidEthereumWalletTransactionRequestOverrideWithGasPriceAndNonce: (_value: string) => true,
  isValidEthereumWalletTransactionRequestOverrideWithGasPriceAndNonceAndData: (_value: string) =>
    true,
  isValidEthereumWalletTransactionRequestOverrideWithGasPriceAndNonceAndDataAndValue: (
    _value: string
  ) => true,
  isValidEthereumWalletTransactionRequestOverrideWithGasPriceAndNonceAndDataAndValueAndChainId: (
    _value: string
  ) => true,
  isValidEthereumWalletTransactionRequestOverrideWithGasPriceAndNonceAndDataAndValueAndChainIdAndType:
    (_value: string) => true,
  isValidEthereumWalletTransactionRequestOverrideWithGasPriceAndNonceAndDataAndValueAndChainIdAndTypeAndAccessList:
    (_value: string) => true,
  isValidUrl: (_value: string) => true,
  isShortUrl: (_value: string) => false,
  isShortUrlByRedirect: async (_value: string) => false
}));

vi.mock('../../src/services/notificationService', () => ({
  getNotificationTemplate: mockGetNotificationTemplate,
  persistNotification: vi.fn(),
  sendInternalErrorNotification: vi.fn(),
  sendNoValidBlockchainConditionsNotification: vi.fn(),
  sendSwapNotification: vi.fn(),
  sendUserInsufficientBalanceNotification: vi.fn(),
  sendOutgoingTransferNotification: vi.fn(),
  sendReceivedTransferNotification: vi.fn(),
  sendWalletAlreadyExistsNotification: vi.fn(),
  sendWalletCreationNotification: vi.fn(),
  sendDepositCta: vi.fn(),
  sendDepositInfo: vi.fn(),
  sendMintNotification: vi.fn(),
  sendAAVECreateSuplyNotification: vi.fn(),
  sendAAVERemoveSuplyNotification: vi.fn(),
  sendAaveSupplyInfoNotification: vi.fn()
}));

vi.mock('../../src/services/userService', () => ({
  getUser: mockGetUser,
  getUserWalletByChainId: mockGetUserWalletByChainId,
  getUserWallet: mockGetUserWallet,
  getUserByTelegramId: mockGetUserByTelegramId,
  hasPhoneAnyOperationInProgress: mockHasPhoneAnyOperationInProgress,
  hasUserAnyOperationInProgress: mockHasUserAnyOperationInProgress,
  openOperation: mockOpenOperation,
  closeOperation: mockCloseOperation,
  getOrCreateUser: mockGetOrCreateUser
}));

vi.mock('../../src/services/referralService', () => ({
  referralService: mockReferralService
}));

vi.mock('../../src/services/blockchainService', () => ({
  getSwapTokensData: mockGetSwapTokensData,
  getTokenData: mockGetTokenData,
  userReachedOperationLimit: mockUserReachedOperationLimit,
  userWithinTokenOperationLimits: mockUserWithinTokenOperationLimits,
  checkBlockchainConditions: vi.fn()
}));

import {
  balanceByPhoneNumber,
  balanceByPhoneNumberSync
} from '../../src/controllers/balanceController';
import { generateNftOriginal } from '../../src/controllers/nftController';
import { generateOnRampLink, linkToOperate } from '../../src/controllers/rampController';
import {
  getReferralByCode,
  getReferralCode,
  getReferralCodeWithUsageCount,
  submitReferralByCode
} from '../../src/controllers/referralController';
import {
  getSecurityEvents,
  getSecurityQuestions,
  getSecurityStatus,
  resetSecurityPin,
  setSecurityPin,
  setSecurityRecoveryQuestions,
  verifySecurityPin
} from '../../src/controllers/securityController';
import { swap } from '../../src/controllers/swapController';
import { issueTokensHandler } from '../../src/controllers/tokenController';
import { makeTransaction } from '../../src/controllers/transactionController';
import { getDepositInfo, getMultichainDepositCta } from '../../src/controllers/walletController';
import { telegramService } from '../../src/services/telegram/telegramService';

const languageCases = [
  { name: 'es', phone: '+5491130000000', lang: 'es' },
  { name: 'pt', phone: '+5511987654321', lang: 'pt' },
  { name: 'en', phone: '+14155552671', lang: 'en' },
  { name: 'default-fr', phone: '+33123456789', lang: 'en' }
] as const;

const makeReply = () => ({}) as FastifyReply;

beforeEach(() => {
  vi.clearAllMocks();

  mockGetNotificationTemplate.mockImplementation(async (phone: string, type: string) => {
    const lang = languageForPhone(phone);
    const key = type as keyof typeof templateMessages;
    return {
      title: 'ChatterPay',
      message: templateMessages[key]?.[lang] ?? ''
    };
  });

  mockReturnSuccessResponse.mockImplementation(
    (_reply: FastifyReply, message: string, data?: Record<string, unknown>) => ({
      status: 'success',
      message,
      data
    })
  );
  mockReturnErrorResponse.mockImplementation(
    (_method: string, _logKey: string, _reply: FastifyReply, code: number, message: string) => ({
      status: 'error',
      code,
      message
    })
  );
  mockReturnErrorResponseAsSuccess.mockImplementation(
    (_method: string, _logKey: string, _reply: FastifyReply, message: string) => ({
      status: 'error',
      code: 200,
      message
    })
  );

  mockGetUser.mockResolvedValue(null);
  mockGetUserByTelegramId.mockResolvedValue(null);
  mockGetUserWalletByChainId.mockResolvedValue(null);
  mockGetUserWallet.mockResolvedValue(null);
  mockHasPhoneAnyOperationInProgress.mockResolvedValue(false);
  mockHasUserAnyOperationInProgress.mockReturnValue(false);
  mockOpenOperation.mockResolvedValue(undefined);
  mockCloseOperation.mockResolvedValue(undefined);
  mockGetOrCreateUser.mockResolvedValue(null);

  mockGetSwapTokensData.mockReturnValue({
    tokenInputAddress: '0x1111111111111111111111111111111111111111',
    tokenOutputAddress: '0x2222222222222222222222222222222222222222'
  });

  mockGetTokenData.mockReturnValue({
    symbol: 'USDC',
    address: '0x1111111111111111111111111111111111111111',
    decimals: 6
  });

  mockUserReachedOperationLimit.mockResolvedValue(false);
  mockUserWithinTokenOperationLimits.mockResolvedValue({ isWithinLimits: true });

  mockReferralService.getOrGenerateReferralCode.mockResolvedValue(null);
  mockReferralService.getReferralByCode.mockResolvedValue(null);
  mockReferralService.getReferralCodeWithUsageCount.mockResolvedValue(null);
  mockReferralService.submitReferrerCode.mockResolvedValue({ status: 'user_not_found' });
});

describe('wallet_not_created templates (controllers)', () => {
  it.each(languageCases)('balanceByPhoneNumber (%s)', async ({ phone, lang }) => {
    const request = { query: { channel_user_id: phone } } as FastifyRequest;
    const result = (await balanceByPhoneNumber(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('balanceByPhoneNumberSync (%s)', async ({ phone, lang }) => {
    const request = { query: { channel_user_id: phone } } as FastifyRequest;
    const result = (await balanceByPhoneNumberSync(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('wallet.getDepositInfo (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await getDepositInfo(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('wallet.getMultichainDepositCta (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await getMultichainDepositCta(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('security.getSecurityStatus (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await getSecurityStatus(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('security.getSecurityQuestions (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await getSecurityQuestions(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('security.getSecurityEvents (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await getSecurityEvents(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('security.setSecurityPin (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone, pin: '123456' } } as FastifyRequest;
    const result = (await setSecurityPin(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('security.verifySecurityPin (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone, pin: '123456' } } as FastifyRequest;
    const result = (await verifySecurityPin(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('security.setSecurityRecoveryQuestions (%s)', async ({ phone, lang }) => {
    const request = {
      body: {
        channel_user_id: phone,
        questions: [
          { key: 'pet_name', answer: 'Firulais' },
          { key: 'birth_city', answer: 'Buenos Aires' }
        ]
      }
    } as FastifyRequest;
    const result = (await setSecurityRecoveryQuestions(request, makeReply())) as {
      message: string;
    };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('security.resetSecurityPin (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await resetSecurityPin(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('referral.getReferralCode (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await getReferralCode(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('referral.getReferralByCode (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await getReferralByCode(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('referral.getReferralCodeWithUsageCount (%s)', async ({ phone, lang }) => {
    const request = { body: { channel_user_id: phone } } as FastifyRequest;
    const result = (await getReferralCodeWithUsageCount(request, makeReply())) as {
      message: string;
    };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('referral.submitReferralByCode (%s)', async ({ phone, lang }) => {
    const request = {
      body: { channel_user_id: phone, referral_by_code: 'ABC123' }
    } as FastifyRequest;
    const result = (await submitReferralByCode(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('ramp.linkToOperate (%s)', async ({ phone, lang }) => {
    const request = {
      body: {
        channel_user_id: phone,
        operation: 'BUY',
        asset: 'USDC',
        against: 'ARS',
        assetAmount: 10
      },
      server: {
        tokens: [{ name: 'USDC', ramp_enabled: true }]
      }
    } as FastifyRequest;
    const result = (await linkToOperate(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('ramp.generateOnRampLink (%s)', async ({ phone, lang }) => {
    const request = { body: { phone_number: phone } } as FastifyRequest;
    const result = (await generateOnRampLink(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('swap (%s)', async ({ phone, lang }) => {
    const request = {
      body: {
        channel_user_id: phone,
        inputCurrency: 'USDC',
        outputCurrency: 'ETH',
        amount: 1
      },
      server: {
        networkConfig: { chainId: 1 },
        tokens: []
      }
    } as FastifyRequest;
    const result = (await swap(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('token.issueTokensHandler (%s)', async ({ phone, lang }) => {
    const request = {
      body: { identifier: phone },
      server: { networkConfig: { environment: 'development', chainId: 1 } }
    } as FastifyRequest;
    const result = (await issueTokensHandler(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('transaction.makeTransaction (%s)', async ({ phone, lang }) => {
    const request = {
      body: {
        channel_user_id: phone,
        to: phone === '+14155552671' ? '+5491130000000' : '+14155552671',
        token: 'USDC',
        amount: '1'
      },
      server: {
        networkConfig: { chainId: 1 },
        tokens: []
      }
    } as FastifyRequest;
    const result = (await makeTransaction(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });

  it.each(languageCases)('nft.generateNftOriginal (%s)', async ({ phone, lang }) => {
    const request = {
      body: {
        channel_user_id: phone,
        url: 'https://example.com/image.png',
        description: 'Test NFT',
        latitude: '0',
        longitude: '0'
      },
      server: {
        networkConfig: { chainId: 1 }
      }
    } as FastifyRequest;
    const result = (await generateNftOriginal(request, makeReply())) as { message: string };
    expect(result.message).toBe(templateMessages.wallet_not_created[lang]);
  });
});

describe('wallet_not_created templates (telegram service)', () => {
  it.each(languageCases)('telegram.startVerificationForPhone (%s)', async ({ phone, lang }) => {
    const result = await telegramService.startVerificationForPhone(123, phone, 'tg-1', 'token', 5);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reply.text).toBe(templateMessages.wallet_not_created[lang]);
    }
  });

  it.each(languageCases)('telegram.handleBalanceMessage (%s)', async ({ phone, lang }) => {
    const reply = await telegramService.handleBalanceMessage(123, `/balance ${phone}`, 'tg-2', {
      networkConfig: { chainId: 1 },
      tokens: []
    });

    expect(reply?.text).toBe(templateMessages.wallet_not_created[lang]);
  });
});
