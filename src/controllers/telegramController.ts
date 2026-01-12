import type { FastifyReply, FastifyRequest } from 'fastify';
import { BOT_DATA_TOKEN } from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import type { IBlockchain } from '../models/blockchainModel';
import type { IToken } from '../models/tokenModel';
import { type ServerCtx, telegramService } from '../services/telegram/telegramService';

// -------------------------------------------------------------------------------------------------------------
// Telegram type definitions (minimal subset used by our bot)
// -------------------------------------------------------------------------------------------------------------

interface TelegramUser {
  readonly id: number;
  readonly first_name?: string;
  readonly username?: string;
}

interface TelegramChat {
  readonly id: number;
  readonly type: string;
}

interface TelegramContact {
  readonly phone_number?: string;
}

interface TelegramMessage {
  readonly message_id: number;
  readonly from: TelegramUser;
  readonly chat: TelegramChat;
  readonly text?: string;
  readonly contact?: TelegramContact;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

// -------------------------------------------------------------------------------------------------------------
// Minimal state to request phone on /wallet when user is not found
// -------------------------------------------------------------------------------------------------------------

// Await 6-digit code after sending WhatsApp
const TELEGRAM_AWAITING_PHONE = new Map<number, true>();

// Await 6-digit code after sending WhatsApp
const TELEGRAM_AWAITING_CODE = new Map<number, { phone: string; expiresAt: number }>();

const CODE_TTL_MIN = 10;

// -------------------------------------------------------------------------------------------------------------
// Handlers (normalized names): /start, /wallet, /balance, dispatcher /webhook
// -------------------------------------------------------------------------------------------------------------

/**
 * Handles `/start` command.
 *
 * @param {FastifyRequest<{ Body: TelegramUpdate }>} request - Telegram webhook payload.
 * @param {FastifyReply} reply - Fastify reply object.
 * @returns {Promise<FastifyReply>} Telegram-compatible response.
 */
async function handleTelegramStart(
  request: FastifyRequest<{ Body: TelegramUpdate }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  const chatId = request.body?.message?.chat?.id ?? null;
  if (!chatId) return reply.status(200).send();

  return reply.send({
    method: 'sendMessage',
    chat_id: chatId,
    text: '👋 Welcome to ChatterPay! Your Web3 wallet on Telegram.'
  });
}

/**
 * Handles `/wallet`. If the user is not found by Telegram ID, requests their phone to link
 * with an existing account. Otherwise, creates/returns the wallet using the Telegram ID as identifier.
 *
 * @param {FastifyRequest<{ Body: TelegramUpdate }>} request - Telegram webhook payload.
 * @param {FastifyReply} reply - Fastify reply object.
 * @returns {Promise<FastifyReply>} Telegram-compatible response.
 */
export const handleTelegramWallet = async (
  request: FastifyRequest<{
    Body: {
      message?: {
        chat?: { id: number; type?: string };
        text?: string;
        from?: { id: number };
        contact?: { phone_number?: string };
      };
    };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const msg = request.body?.message;
  const chatId = msg?.chat?.id ?? null;
  const text = msg?.text?.trim() ?? '';
  const lower = text.toLowerCase();
  const fromId = msg?.from?.id?.toString() ?? null;

  if (!chatId || !fromId || lower !== '/wallet') {
    return reply.status(200).send(); // ignore noise
  }

  const logKey = `[op:telegramWallet:${fromId}]`;

  try {
    // DELEGATE: service decides if we need a phone or we can return the wallet now
    const ctx: ServerCtx = {
      networkConfig: (request.server as unknown as { networkConfig: IBlockchain }).networkConfig,
      tokens: (request.server as unknown as { tokens: IToken[] }).tokens
    };

    const { reply: out, needsPhone } = await telegramService.handleWalletEntry(
      chatId,
      fromId,
      ctx,
      logKey
    );

    if (needsPhone) {
      TELEGRAM_AWAITING_PHONE.set(chatId, true);
    }

    return await reply.send(out);
  } catch (err) {
    Logger.error('telegramWallet', logKey, (err as Error).message);
    return reply.send({
      method: 'sendMessage',
      chat_id: chatId,
      text: 'Error while processing your wallet request.',
      parse_mode: 'Markdown'
    });
  }
};

/**
 * Handles `/balance`.
 * Reuses the SAME services: getUser, getUserWalletByChainId, computeAddressBalanceWithNfts.
 *
 * @param {FastifyRequest<{ Body: TelegramUpdate }>} request - Telegram webhook payload.
 * @param {FastifyReply} reply - Fastify reply object.
 * @returns {Promise<FastifyReply>} Telegram-compatible response.
 */
export const handleTelegramBalance = async (
  request: FastifyRequest<{ Body: TelegramUpdate }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const message = request.body?.message;
  const chatId = message?.chat?.id ?? null;
  const text = message?.text?.trim() ?? '';
  const telegramUserId = message?.from?.id?.toString() ?? null;

  const logKey = `[op:telegramBalance:${telegramUserId || 'unknown'}]`;

  try {
    const ctx: ServerCtx = {
      networkConfig: (request.server as unknown as { networkConfig: IBlockchain }).networkConfig,
      tokens: (request.server as unknown as { tokens: IToken[] }).tokens
    };

    const out = await telegramService.handleBalanceMessage(chatId, text, telegramUserId, ctx);

    if (out) return await reply.send(out);
    return await reply.status(200).send();
  } catch (err) {
    Logger.error(logKey, (err as Error).message);
    return reply.send({
      method: 'sendMessage',
      chat_id: chatId as number,
      text: 'Unexpected error while fetching your balance.',
      parse_mode: 'Markdown'
    });
  }
};

// -------------------------------------------------------------------------------------------------------------
// Dispatcher: /webhook — routes /start, /wallet, /balance and handles phone reply when requested
// -------------------------------------------------------------------------------------------------------------
/**
 * Dispatches Telegram updates to the appropriate handler and handles phone linking flow.
 * Recognized commands: /start, /wallet, /balance.
 * If `/wallet` asked for a phone, this handler captures contact or text message to continue the flow.
 *
 * @param {FastifyRequest<{ Body: TelegramUpdate }>} request - Telegram webhook payload.
 * @param {FastifyReply} reply - Fastify reply object.
 * @returns {Promise<FastifyReply>} Telegram-compatible response.
 */
export async function handleTelegramUpdate(
  request: FastifyRequest<{
    Body: {
      message?: {
        chat?: { id: number; type?: string };
        text?: string;
        from?: { id: number };
        contact?: { phone_number?: string };
      };
    };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> {
  const msg = request.body?.message;
  const chatIdRaw = msg?.chat?.id;
  const chatId: number | null = typeof chatIdRaw === 'number' ? chatIdRaw : null;
  const textRaw = msg?.text;
  const text: string = typeof textRaw === 'string' ? textRaw.trim() : '';
  const lower = text.toLowerCase();
  const fromIdRaw = msg?.from?.id;
  const fromId: string | null = typeof fromIdRaw === 'number' ? String(fromIdRaw) : null;
  const contactPhoneRaw = msg?.contact?.phone_number;
  const contactPhone: string = typeof contactPhoneRaw === 'string' ? contactPhoneRaw.trim() : '';

  // [PATCH] Handle “Share my phone 📱” even if TELEGRAM_AWAITING_PHONE flag was lost
  if (contactPhone && chatId !== null && !TELEGRAM_AWAITING_PHONE.has(chatId)) {
    const phone = contactPhone;
    const safeChatId: number = chatId;
    const safeFromId: string = fromId ?? 'unknown';

    Logger.info(`[telegramLink:unflagged] Received phone ${phone}`);

    try {
      const result = await telegramService.startVerificationForPhone(
        safeChatId,
        phone,
        safeFromId,
        BOT_DATA_TOKEN!,
        CODE_TTL_MIN
      );

      if (result.ok) {
        TELEGRAM_AWAITING_CODE.set(safeChatId, {
          phone: result.phone,
          expiresAt: result.expiresAt
        });
      }

      return await reply.send(result.reply);
    } catch (err) {
      Logger.error('telegramWalletCodeUnflagged', String(safeChatId), (err as Error).message);
      return reply.send({
        method: 'sendMessage',
        chat_id: safeChatId,
        text: 'Could not start phone verification right now.',
        parse_mode: 'Markdown'
      });
    }
  } else if (contactPhone && chatId === null) {
    // Defensive fallback — log and ignore if contact without chatId
    Logger.error('telegramUpdate', 'Received contact but chatId was null');
    return reply.status(200).send();
  }

  // Route base commands
  if (lower === '/start')
    return handleTelegramStart(request as FastifyRequest<{ Body: TelegramUpdate }>, reply);
  if (lower === '/wallet') return handleTelegramWallet(request, reply);
  if (lower.startsWith('/balance'))
    return handleTelegramBalance(request as FastifyRequest<{ Body: TelegramUpdate }>, reply);

  // Step A: awaiting phone
  if (chatId && TELEGRAM_AWAITING_PHONE.has(chatId)) {
    const candidateRaw = contactPhone || text || '';

    // Remove awaiting flag regardless of outcome (kept same behavior as before)
    TELEGRAM_AWAITING_PHONE.delete(chatId);

    try {
      const result = await telegramService.startVerificationForPhone(
        chatId,
        candidateRaw,
        fromId ?? 'unknown',
        BOT_DATA_TOKEN!,
        CODE_TTL_MIN
      );

      if (result.ok) {
        TELEGRAM_AWAITING_CODE.set(chatId, {
          phone: result.phone,
          expiresAt: result.expiresAt
        });
      }

      return await reply.send(result.reply);
    } catch (err) {
      Logger.error('telegramWalletCode', String(chatId), (err as Error).message);
      return reply.send({
        method: 'sendMessage',
        chat_id: chatId,
        text: 'Could not start phone verification right now.',
        parse_mode: 'Markdown'
      });
    }
  }

  // Step B: awaiting code
  if (chatId && TELEGRAM_AWAITING_CODE.has(chatId)) {
    const pending = TELEGRAM_AWAITING_CODE.get(chatId);
    const typed = text.trim();

    if (!pending) return reply.status(200).send();

    try {
      const ctx: ServerCtx = {
        networkConfig: (request.server as unknown as { networkConfig: IBlockchain }).networkConfig,
        tokens: (request.server as unknown as { tokens: IToken[] }).tokens
      };

      const result = await telegramService.verifyCodeAndReturnWallet(
        chatId,
        typed,
        fromId,
        pending,
        ctx
      );

      // Maintain same map cleanup semantics
      if (result.expired || result.done) {
        TELEGRAM_AWAITING_CODE.delete(chatId);
      }

      return await reply.send(result.reply);
    } catch (err) {
      Logger.error('telegramWalletVerify', String(chatId), (err as Error).message);
      return reply.send({
        method: 'sendMessage',
        chat_id: chatId,
        text: 'Could not verify the code right now.',
        parse_mode: 'Markdown'
      });
    }
  }

  // Not a /wallet flow message
  return reply.status(200).send();
}
