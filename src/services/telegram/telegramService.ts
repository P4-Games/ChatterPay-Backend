import { IToken } from '../../models/tokenModel';
import { Logger } from '../../helpers/loggerHelper';
import { IBlockchain } from '../../models/blockchainModel';
import { IUser, IUserWallet } from '../../models/userModel';
import { getAddressBalanceWithNfts } from '../balanceService';
import { Currency, BalanceInfo } from '../../types/commonType';
import { chatizaloService } from '../chatizalo/chatizaloService';
import { isValidPhoneNumber } from '../../helpers/validationHelper';
import { tryIssueTokens, createOrReturnWallet } from '../walletService';
import {
  IS_DEVELOPMENT,
  ISSUER_TOKENS_ENABLED,
  COMMON_REPLY_WALLET_NOT_CREATED
} from '../../config/constants';
import {
  getUser,
  getUserByTelegramId,
  getUserWalletByChainId,
  setUserVerificationCode,
  getUserVerificationCode,
  setUserTelegramIdByPhone,
  clearUserVerificationCode
} from '../userService';

/** Telegram-compatible reply payload (what the controller sends back). */
export type TelegramReplyPayload = {
  method: 'sendMessage';
  chat_id: number;
  text: string;
  parse_mode?: 'Markdown';
  reply_markup?: unknown;
};

/** Minimal server context required by wallet/balance logic. */
export type ServerCtx = {
  networkConfig: IBlockchain;
  tokens: IToken[];
};

/** 6-digit validator. */
const isSixDigits = (s: string): boolean => /^\d{6}$/.test(s);

const LINK_COPY = [
  'To keep going, we need to link your Telegram to your existing ChatterPay account on WhatsApp.',
  '',
  'If you don’t have one yet, you can create it at chatterpay.net.',
  '',
  'If you already have an account, enter your phone number in international format or tap “Share my phone 📱”.',
  'We’ll send a 6-digit code to the ChatterPay WhatsApp bot. Enter that code here to finish linking.'
].join('\n');

const BALANCE_LINK_COPY = [
  'To view your balance, we need to link your Telegram to your existing ChatterPay account on WhatsApp.',
  '',
  'If you already have an account, send /wallet and follow the steps to link your phone.',
  'If you don’t have an account yet, you can create it at chatterpay.net and then use /wallet.'
].join('\n');

/** Reply keyboard to request phone contact. */
function phoneRequestKeyboard() {
  return {
    keyboard: [[{ text: 'Share my phone 📱', request_contact: true }]],
    one_time_keyboard: true,
    resize_keyboard: true
  };
}

export const telegramService = {
  /**
   * Wallet entry flow for `/wallet`.
   * If Telegram ID is already linked, returns the wallet message.
   * Otherwise, returns the phone prompt. Controller decides state handling.
   *
   * @param chatId Chat identifier
   * @param fromId Telegram user id (string)
   * @param ctx Server context (networkConfig, tokens)
   * @param logKey Prefixed key for logging
   * @returns Telegram reply and a flag indicating if phone is needed
   */
  handleWalletEntry: async (
    chatId: number,
    fromId: string,
    ctx: ServerCtx,
    logKey: string
  ): Promise<{ reply: TelegramReplyPayload; needsPhone: boolean }> => {
    const existing: IUser | null = await getUserByTelegramId(fromId);

    if (existing) {
      const { networkConfig, tokens } = ctx;
      const {
        message: resultMessage,
        walletAddress,
        wasWalletCreated
      } = await createOrReturnWallet(existing.phone_number, networkConfig, logKey);

      if (
        wasWalletCreated &&
        networkConfig.environment.toUpperCase() !== 'PRODUCTION' &&
        IS_DEVELOPMENT &&
        ISSUER_TOKENS_ENABLED
      ) {
        Logger.log('telegramWallet', logKey, `Issuing tokens for ${walletAddress}`);
        await tryIssueTokens(walletAddress, tokens, networkConfig);
      }

      Logger.info('telegramWallet', logKey, `${resultMessage}, ${walletAddress}`);

      return {
        reply: {
          method: 'sendMessage',
          chat_id: chatId,
          text: wasWalletCreated
            ? `🆕 Wallet created:\n\`${walletAddress}\`\nYou’re ready to use ChatterPay 🚀`
            : `✅ Wallet:\n\`${walletAddress}\`\nWelcome back 💸`,
          parse_mode: 'Markdown'
        },
        needsPhone: false
      };
    }

    return {
      reply: {
        method: 'sendMessage',
        chat_id: chatId,
        text: LINK_COPY,
        reply_markup: phoneRequestKeyboard()
      },
      needsPhone: true
    };
  },

  /**
   * Starts phone verification:
   * - Validates the phone
   * - Generates and stores a 6-digit code
   * - Sends WhatsApp message via Chatizalo
   *
   * @param chatId Chat identifier
   * @param candidateRaw Phone candidate (text or contact), any formatting
   * @param fromId Telegram user id (string)
   * @param botDataToken Token for Chatizalo integration
   * @param codeTtlMin Code TTL in minutes
   * @returns On success: reply + phone + expiresAt; otherwise reply with error
   */
  startVerificationForPhone: async (
    chatId: number,
    candidateRaw: string,
    fromId: string,
    botDataToken: string,
    codeTtlMin: number
  ): Promise<
    | { ok: true; reply: TelegramReplyPayload; phone: string; expiresAt: number }
    | { ok: false; reply: TelegramReplyPayload }
  > => {
    const candidateNoSpaces = candidateRaw.replace(/\s+/g, '');
    const candidate = candidateNoSpaces.startsWith('+')
      ? candidateNoSpaces
      : `+${candidateNoSpaces}`.replace(/\+\+/, '+');

    if (!candidate || !isValidPhoneNumber(candidate)) {
      return {
        ok: false,
        reply: {
          method: 'sendMessage',
          chat_id: chatId,
          text:
            'Invalid phone number. Send a valid number (no spaces or symbols) or ' +
            'tap “Share my phone 📱”.',
          reply_markup: phoneRequestKeyboard()
        }
      };
    }

    const user = await getUser(candidate);
    if (!user) {
      return {
        ok: false,
        reply: {
          method: 'sendMessage',
          chat_id: chatId,
          text: COMMON_REPLY_WALLET_NOT_CREATED,
          parse_mode: 'Markdown'
        }
      };
    }

    const code = await setUserVerificationCode(user.phone_number);
    if (code === null) {
      Logger.error('telegramWalletCode', user.phone_number, 'Failed to set verification code');
      return {
        ok: false,
        reply: {
          method: 'sendMessage',
          chat_id: chatId,
          text: 'We could not start the verification. Please try again.',
          parse_mode: 'Markdown'
        }
      };
    }

    const message = [
      `Someone requested to link this phone with Telegram (ID ${fromId || 'unknown'}).`,
      `If this was not you, ignore this message.`,
      `If it was you, enter this code in Telegram (ChatterPay Bot): *${code}*`,
      ``,
      `This code expires in ${codeTtlMin} minutes.`
    ].join('\n');

    await chatizaloService.sendBotNotification({
      data_token: botDataToken,
      channel_user_id: user.phone_number,
      message
    });

    return {
      ok: true,
      phone: user.phone_number,
      expiresAt: Date.now() + codeTtlMin * 60 * 1000,
      reply: {
        method: 'sendMessage',
        chat_id: chatId,
        text:
          `We sent a 6-digit code to your WhatsApp (${user.phone_number}). ` +
          `Type it here to continue.`,
        parse_mode: 'Markdown'
      }
    };
  },

  /**
   * Verifies the 6-digit code and, if valid, links Telegram ID to the user,
   * clears the code, and returns the wallet message.
   *
   * @param chatId Chat identifier
   * @param typedCode User-typed code (from Telegram text)
   * @param fromId Telegram user id (string | null)
   * @param pending Pending object with phone and expiresAt
   * @param ctx Server context
   * @returns Reply; flags to tell controller if expired or completed
   */
  verifyCodeAndReturnWallet: async (
    chatId: number,
    typedCode: string,
    fromId: string | null,
    pending: { phone: string; expiresAt: number },
    ctx: ServerCtx
  ): Promise<{ reply: TelegramReplyPayload; expired?: true; done?: true }> => {
    if (pending.expiresAt < Date.now()) {
      await clearUserVerificationCode(pending.phone);
      return {
        expired: true,
        reply: {
          method: 'sendMessage',
          chat_id: chatId,
          text: 'Your verification code expired. Send /wallet again to restart.'
        }
      };
    }

    if (!isSixDigits(typedCode)) {
      return {
        reply: {
          method: 'sendMessage',
          chat_id: chatId,
          text: 'Please type the 6-digit code we sent to your WhatsApp.'
        }
      };
    }

    const stored = await getUserVerificationCode(pending.phone);
    if (stored === null || String(stored) !== typedCode) {
      return {
        reply: {
          method: 'sendMessage',
          chat_id: chatId,
          text: 'That code is not valid. Try again.'
        }
      };
    }

    if (!fromId) {
      return {
        reply: {
          method: 'sendMessage',
          chat_id: chatId,
          text: 'Cannot complete linking: missing Telegram user ID.'
        }
      };
    }

    await setUserTelegramIdByPhone(pending.phone, fromId);
    await clearUserVerificationCode(pending.phone);

    const { networkConfig, tokens } = ctx;
    const {
      message: resultMessage,
      walletAddress,
      wasWalletCreated
    } = await createOrReturnWallet(
      pending.phone,
      networkConfig,
      `[op:telegramWalletLink:${pending.phone}]`
    );

    if (
      wasWalletCreated &&
      networkConfig.environment.toUpperCase() !== 'PRODUCTION' &&
      IS_DEVELOPMENT &&
      ISSUER_TOKENS_ENABLED
    ) {
      Logger.log('telegramWalletLink', pending.phone, `Issuing tokens for ${walletAddress}`);
      await tryIssueTokens(walletAddress, tokens, networkConfig);
    }

    Logger.info('telegramWalletLink', pending.phone, `${resultMessage}, ${walletAddress}`);

    return {
      done: true,
      reply: {
        method: 'sendMessage',
        chat_id: chatId,
        text: wasWalletCreated
          ? `✅ Phone verified. Wallet created:\n\`${walletAddress}\`\nYou’re all set.`
          : `✅ Phone verified. Wallet:\n\`${walletAddress}\`\nYou’re good to go.`,
        parse_mode: 'Markdown'
      }
    };
  },

  /**
   * Handles `/balance` using explicit phone after the command or the
   * phone linked to the Telegram ID. Returns the formatted summary.
   *
   * @param chatId Chat identifier
   * @param text Full text received (may contain "/balance <phone>")
   * @param telegramUserId Telegram user id (string)
   * @param ctx Server context
   * @returns Telegram reply or null when not a /balance command
   */
  handleBalanceMessage: async (
    chatId: number | null,
    text: string,
    telegramUserId: string | null,
    ctx: ServerCtx
  ): Promise<TelegramReplyPayload | null> => {
    if (!chatId || !telegramUserId || !text.toLowerCase().startsWith('/balance')) {
      return null;
    }

    // Try explicit phone in the command
    const maybePhone = (text.split(/\s+/)[1] ?? '').trim();

    // Try linked phone
    const linkedPhone = (await getUserByTelegramId(telegramUserId))?.phone_number ?? null;

    // If there is neither an explicit phone nor a linked phone, just point to /wallet.
    if (!maybePhone && !linkedPhone) {
      return {
        method: 'sendMessage',
        chat_id: chatId,
        text: BALANCE_LINK_COPY
      };
    }

    // Use explicit phone if valid; otherwise fall back to linked
    const phoneCandidate = isValidPhoneNumber(maybePhone) ? maybePhone : linkedPhone;

    if (!phoneCandidate || !isValidPhoneNumber(phoneCandidate)) {
      return {
        method: 'sendMessage',
        chat_id: chatId,
        text: COMMON_REPLY_WALLET_NOT_CREATED,
        parse_mode: 'Markdown'
      };
    }

    const user: IUser | null = await getUser(phoneCandidate);
    if (!user) {
      return {
        method: 'sendMessage',
        chat_id: chatId,
        text: COMMON_REPLY_WALLET_NOT_CREATED,
        parse_mode: 'Markdown'
      };
    }

    const { networkConfig, tokens } = ctx;
    const userWallet = getUserWalletByChainId(
      user.wallets,
      networkConfig.chainId
    ) as IUserWallet | null;

    if (!userWallet || !userWallet.wallet_proxy || !userWallet.wallet_eoa) {
      return {
        method: 'sendMessage',
        chat_id: chatId,
        text: 'Wallet not found.',
        parse_mode: 'Markdown'
      };
    }
    const data = await getAddressBalanceWithNfts(
      user.phone_number,
      userWallet.wallet_proxy,
      userWallet.wallet_eoa,
      networkConfig,
      tokens
    );

    const USD = 'USD' as const satisfies Currency;
    const toFixed2 = (n: number): string => Number(n).toFixed(2);
    const toFixed6 = (n: number): string => Number(n).toFixed(6);
    const usdFrom = (rec?: Record<Currency, number>): number => Number((rec && rec[USD]) ?? 0);

    const totalUsd = Number((data.totals && data.totals[USD]) ?? 0);
    const balances: BalanceInfo[] = Array.isArray(data.balances) ? data.balances : [];

    const sorted: BalanceInfo[] = balances
      .slice()
      .sort((a, b) => usdFrom(b.balance_conv) - usdFrom(a.balance_conv))
      .slice(0, 5);

    const headerLines: string[] = [
      `*Balance for ${phoneCandidate}*`,
      `Total: *$${toFixed2(totalUsd)}*`
    ];

    const tokenLines: string[] = sorted.map((t) => {
      const sym = t.token || '—';
      const amt = Number.isFinite(t.balance) ? toFixed6(t.balance) : '0';
      const usd = toFixed2(usdFrom(t.balance_conv));
      const chain = (t.network ?? '').toString().trim();
      return `• ${sym}: ${amt} · $${usd}${chain ? ` · ${chain}` : ''}`;
    });

    const extra = Math.max(0, balances.length - sorted.length);

    const textOut = [
      ...headerLines,
      ...(sorted.length > 0
        ? ['', '*Top tokens*', ...tokenLines, ...(extra > 0 ? [`… and ${extra} more`] : [])]
        : [])
    ].join('\n');

    return {
      method: 'sendMessage',
      chat_id: chatId,
      text: textOut,
      parse_mode: 'Markdown'
    };
  }
};
