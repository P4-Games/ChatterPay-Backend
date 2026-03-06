import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const templateMessages = {
  operation_in_progress: {
    en: 'The operation is being processed. We will notify you once it is completed or if any issues arise.',
    es: 'La operaci?n est? siendo procesada. Te notificaremos una vez que se complete o si surge alg?n inconveniente.',
    pt: 'A opera??o est? sendo processada. Avisaremos voc? assim que for conclu?da ou se ocorrer algum problema.'
  },
  wallet_not_created: {
    en: "A wallet linked to your phone number hasn't been created yet. Please create one to continue with the operation.",
    es: 'A?n no se cre? una wallet vinculada a tu n?mero de tel?fono. Por favor, cre? una para continuar con la operaci?n.',
    pt: 'Uma carteira vinculada ao seu n?mero de telefone ainda n?o foi criada. Por favor, crie uma para continuar com a opera??o.'
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
const mockHasPhoneAnyOperationInProgress = vi.hoisted(() => vi.fn());
const mockHasUserAnyOperationInProgress = vi.hoisted(() => vi.fn());
const mockOpenOperation = vi.hoisted(() => vi.fn());
const mockCloseOperation = vi.hoisted(() => vi.fn());

const mockGetSwapTokensData = vi.hoisted(() => vi.fn());
const mockGetTokenData = vi.hoisted(() => vi.fn());
const mockUserReachedOperationLimit = vi.hoisted(() => vi.fn());
const mockUserWithinTokenOperationLimits = vi.hoisted(() => vi.fn());

const mockSetupERC20 = vi.hoisted(() => vi.fn());
const mockGetBs = vi.hoisted(() => vi.fn());

const mockVerifyWalletBalanceInRpc = vi.hoisted(() => vi.fn());

const mockGetOperationGate = vi.hoisted(() => vi.fn());

const mockDownloadAndProcessImage = vi.hoisted(() => vi.fn());

vi.mock('../../src/helpers/requestHelper', () => ({
  returnSuccessResponse: mockReturnSuccessResponse,
  returnErrorResponse: mockReturnErrorResponse,
  returnErrorResponseAsSuccess: mockReturnErrorResponseAsSuccess
}));

vi.mock('../../src/helpers/validationHelper', () => ({
  isValidPhoneNumber: (value: string) => /\d{8,15}/.test(value.replace(/\D/g, '')),
  isValidEthereumWallet: (value: string) => value.startsWith('0x') && value.length >= 10,
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
  sendMintNotification: vi.fn(),
  sendAAVECreateSuplyNotification: vi.fn(),
  sendAAVERemoveSuplyNotification: vi.fn(),
  sendAaveSupplyInfoNotification: vi.fn()
}));

vi.mock('../../src/services/userService', () => ({
  getUser: mockGetUser,
  getUserWalletByChainId: mockGetUserWalletByChainId,
  getUserWallet: mockGetUserWallet,
  hasPhoneAnyOperationInProgress: mockHasPhoneAnyOperationInProgress,
  hasUserAnyOperationInProgress: mockHasUserAnyOperationInProgress,
  openOperation: mockOpenOperation,
  closeOperation: mockCloseOperation,
  getOrCreateUser: vi.fn()
}));

vi.mock('../../src/services/blockchainService', () => ({
  getSwapTokensData: mockGetSwapTokensData,
  getTokenData: mockGetTokenData,
  userReachedOperationLimit: mockUserReachedOperationLimit,
  userWithinTokenOperationLimits: mockUserWithinTokenOperationLimits,
  checkBlockchainConditions: vi.fn()
}));

vi.mock('../../src/services/web3/contractSetupService', () => ({
  setupERC20: mockSetupERC20
}));

vi.mock('../../src/services/secService', () => ({
  secService: { get_bs: mockGetBs }
}));

vi.mock('../../src/services/balanceService', () => ({
  verifyWalletBalanceInRpc: mockVerifyWalletBalanceInRpc,
  getTokenPrices: vi.fn()
}));

vi.mock('../../src/services/securityService', () => ({
  securityService: { getOperationGate: mockGetOperationGate }
}));

vi.mock('../../src/services/imageService', () => ({
  downloadAndProcessImage: mockDownloadAndProcessImage
}));

import {
  aaveCreateSupply,
  aaveGetSupplyInfo,
  aaveRemoveSupply,
  aaveUpdateSupply
} from '../../src/controllers/aaveController';
import { generateNftCopy, generateNftOriginal } from '../../src/controllers/nftController';
import { swap } from '../../src/controllers/swapController';
import { makeTransaction } from '../../src/controllers/transactionController';

const languageCases = [
  { name: 'es', phone: '+5491130000000', lang: 'es' },
  { name: 'pt', phone: '+5511987654321', lang: 'pt' },
  { name: 'en', phone: '+14155552671', lang: 'en' },
  { name: 'default-fr', phone: '+33123456789', lang: 'en' }
] as const;

const makeReply = () =>
  ({
    send: vi.fn(),
    raw: { writableFinished: true }
  }) as unknown as FastifyReply;

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
  mockGetUserWalletByChainId.mockResolvedValue({
    wallet_proxy: '0xproxy',
    wallet_eoa: '0xeoa'
  });
  mockGetUserWallet.mockResolvedValue({
    wallet_proxy: '0xproxy',
    wallet_eoa: '0xeoa'
  });
  mockHasPhoneAnyOperationInProgress.mockResolvedValue(false);
  mockHasUserAnyOperationInProgress.mockReturnValue(false);
  mockOpenOperation.mockResolvedValue(undefined);
  mockCloseOperation.mockResolvedValue(undefined);

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

  mockSetupERC20.mockImplementation(async () => ({
    decimals: async () => 6,
    balanceOf: async () => ({ gte: () => false })
  }));

  mockGetBs.mockReturnValue({ address: '0xbs' });

  mockVerifyWalletBalanceInRpc.mockResolvedValue({
    enoughBalance: false,
    amountToCheck: '1',
    walletBalance: '0'
  });

  mockGetOperationGate.mockResolvedValue({ allowed: true });

  mockDownloadAndProcessImage.mockRejectedValue(new Error('skip'));
});

describe('operation_in_progress templates', () => {
  it.each(languageCases)('aaveCreateSupply (%s)', async ({ phone, lang }) => {
    const reply = makeReply();
    await aaveCreateSupply(
      { body: { channel_user_id: phone, amount: '1', token: 'USDC' } } as FastifyRequest,
      reply
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: templateMessages.operation_in_progress[lang] })
      })
    );
  });

  it.each(languageCases)('aaveUpdateSupply (%s)', async ({ phone, lang }) => {
    const reply = makeReply();
    await aaveUpdateSupply(
      { body: { channel_user_id: phone, amount: '1', token: 'USDC' } } as FastifyRequest,
      reply
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: templateMessages.operation_in_progress[lang] })
      })
    );
  });

  it.each(languageCases)('aaveRemoveSupply (%s)', async ({ phone, lang }) => {
    const reply = makeReply();
    await aaveRemoveSupply(
      { body: { channel_user_id: phone, token: 'USDC' } } as FastifyRequest,
      reply
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: templateMessages.operation_in_progress[lang] })
      })
    );
  });

  it.each(languageCases)('aaveGetSupplyInfo (%s)', async ({ phone, lang }) => {
    const reply = makeReply();
    await aaveGetSupplyInfo({ body: { channel_user_id: phone } } as FastifyRequest, reply);

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: templateMessages.operation_in_progress[lang] })
      })
    );
  });

  it.each(languageCases)('swap (%s)', async ({ phone, lang }) => {
    mockGetUser.mockResolvedValue({
      phone_number: phone,
      wallets: [{ wallet_proxy: '0xproxy' }]
    });

    const request = {
      body: {
        channel_user_id: phone,
        inputCurrency: 'USDC',
        outputCurrency: 'ETH',
        amount: 1
      },
      server: {
        networkConfig: { chainId: 1, rpc: 'http://localhost' },
        tokens: []
      }
    } as FastifyRequest;

    await swap(request, {} as FastifyReply);

    expect(mockReturnSuccessResponse).toHaveBeenCalled();
    expect(mockReturnSuccessResponse.mock.calls[0]?.[1]).toBe(
      templateMessages.operation_in_progress[lang]
    );
  });

  it.each(languageCases)('transaction.makeTransaction (%s)', async ({ phone, lang }) => {
    mockGetUser.mockResolvedValue({
      phone_number: phone,
      wallets: [{ wallet_proxy: '0xproxy', wallet_eoa: '0xeoa' }]
    });

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

    await makeTransaction(request, {} as FastifyReply);

    expect(mockReturnSuccessResponse).toHaveBeenCalled();
    expect(mockReturnSuccessResponse.mock.calls[0]?.[1]).toBe(
      templateMessages.operation_in_progress[lang]
    );
  });

  it.each(languageCases)('nft.generateNftOriginal (%s)', async ({ phone, lang }) => {
    mockGetUser.mockResolvedValue({ phone_number: phone, wallets: [{ wallet_proxy: '0xproxy' }] });
    mockGetUserWallet.mockResolvedValue({ wallet_proxy: '0xproxy' });

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

    await generateNftOriginal(request, {} as FastifyReply);

    expect(mockReturnSuccessResponse).toHaveBeenCalled();
    expect(mockReturnSuccessResponse.mock.calls[0]?.[1]).toBe(
      templateMessages.operation_in_progress[lang]
    );
  });

  it.each(languageCases)('nft.generateNftCopy (%s)', async ({ phone, lang }) => {
    mockOpenOperation.mockRejectedValueOnce(new Error('stop'));

    const request = {
      body: { channel_user_id: phone, id: 'nft-1' },
      server: { networkConfig: { chainId: 1, contracts: {} } }
    } as FastifyRequest;

    const nftModule = await import('../../src/models/nftModel');
    vi.spyOn(nftModule.default, 'find').mockResolvedValueOnce([{ id: 'nft-1' }] as any);

    await generateNftCopy(request, {} as FastifyReply);

    expect(mockReturnSuccessResponse).toHaveBeenCalled();
    expect(mockReturnSuccessResponse.mock.calls[0]?.[1]).toBe(
      templateMessages.operation_in_progress[lang]
    );
  });
});
