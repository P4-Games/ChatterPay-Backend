/**
 * `make_transaction` for Cardano.
 *
 * A sibling of `makeTransaction` rather than a branch inside it. Extracting a `transferRouter` and
 * moving the EVM steps behind it is still the right
 * end state — but it is a refactor of the live money path, and doing it in the same change that
 * introduces a new chain means that any regression on EVM has two candidate causes. So the EVM
 * function is left byte-for-byte untouched here, and the extraction stays queued as its own change.
 *
 * What is *not* duplicated is policy. The concurrency lock, the security gate, the daily and
 * per-amount limits, chatterpoints and the notifications are the same functions the EVM path calls.
 * A change to any of them applies to both chains, which is the property that matters: those are
 * product rules, not EVM details.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { getCardanoConfig } from '../config/cardanoConfig';
import { chargesTransferFee, getCardanoFeeConfig } from '../config/cardanoFeeConfig';
import { areSamePhoneNumber } from '../helpers/formatHelper';
import { Logger } from '../helpers/loggerHelper';
import { returnErrorResponseAsSuccess, returnSuccessResponse } from '../helpers/requestHelper';
import { delaySeconds } from '../helpers/timeHelper';
import { NotificationEnum } from '../models/templateModel';
import type { IToken } from '../models/tokenModel';
import type { IUser } from '../models/userModel';
import {
  userReachedOperationLimit,
  userWithinTokenOperationLimits
} from '../services/blockchainService';
import { chatterPayFeeUnits } from '../services/cardano/cardanoFeeService';
import {
  executeCardanoOperation,
  resolveCardanoToken
} from '../services/cardano/cardanoOperationService';
import {
  canAffordCardanoTransfer,
  sponsorCanCoverFee
} from '../services/cardano/cardanoPreflightService';
import { deriveCardanoAccount } from '../services/cardano/cardanoWalletService';
import {
  chatterpointsService,
  type RegisterOperationResult
} from '../services/chatterpointsService';
import { mongoBlockchainService } from '../services/mongo/mongoBlockchainService';
import { mongoTransactionService } from '../services/mongo/mongoTransactionService';
import { mongoUserService } from '../services/mongo/mongoUserService';
import {
  getNotificationTemplate,
  persistAndSendNotification,
  persistNotification,
  sendInternalErrorNotification,
  sendOutgoingTransferNotification,
  sendReceivedTransferNotification
} from '../services/notificationService';
import { securityService } from '../services/securityService';
import {
  closeOperation,
  getUser,
  hasUserAnyOperationInProgress,
  openOperation
} from '../services/userService';
import { ConcurrentOperationsEnum, type TransactionData } from '../types/commonType';

/** The chain's own coin: the default asset, and the one every fee is charged in. */
const ADA_SYMBOL = 'ADA';

/**
 * The machine-readable part of an error, and only that part.
 *
 * Anything raised below here may carry a provider hostname, a response body or a pair of derived
 * addresses in its message, and this value is answered to the caller. The codes already say what
 * happened; the text is for the log.
 *
 * @param error - Whatever was caught.
 * @returns The `CARDANO_*` code when there is one, `CARDANO_UNEXPECTED_ERROR` otherwise.
 */
function cardanoErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^CARDANO_[A-Z_]+/.exec(message)?.[0] ?? 'CARDANO_UNEXPECTED_ERROR';
}

/**
 * Whether a `make_transaction` request is asking for Cardano.
 *
 * Three ways to say it, because three callers already exist: the bot sends `network`, the dashboard
 * sends `chain_id`, and a bare ticker has to be resolved against what is actually configured.
 *
 * The ticker is matched against the token catalogue rather than a hardcoded list, so adding a
 * stablecoin is a database row and not a code change. **A ticker that also exists on the active EVM
 * network stays on EVM**: diverting a working USDC transfer because someone later listed a token of
 * the same name on Cardano would break a live feature, and the caller can always be explicit with
 * `network` or `chain_id`.
 *
 * @param body - The request body.
 * @param tokens - The token catalogue, as the Fastify instance caches it.
 * @param evmChainId - Chain id of the EVM network this instance operates on.
 * @returns `true` when the request should be handled by the Cardano path.
 */
export function isCardanoTransferRequest(
  body: { token?: string; network?: string; chain_id?: string },
  tokens: IToken[] = [],
  evmChainId?: number
): boolean {
  const { chainId } = getCardanoConfig();
  if (body.network && body.network.trim().toLowerCase().startsWith('cardano')) return true;
  if (body.chain_id && Number.parseInt(body.chain_id, 10) === chainId) return true;

  const symbol = (body.token ?? '').trim().toUpperCase();
  if (!symbol) return false;

  const matches = (token: IToken, id: number): boolean =>
    token.chain_id === id && token.symbol.trim().toUpperCase() === symbol;

  if (evmChainId !== undefined && tokens.some((token) => matches(token, evmChainId))) return false;
  return tokens.some((token) => matches(token, chainId));
}

export interface MakeCardanoTransactionInputs {
  channel_user_id: string;
  to: string;
  token: string;
  amount: string;
  chain_id?: string;
  network?: string;
  user_notes?: string;
}

/**
 * Validates what can be validated without touching the chain or the database.
 *
 * @param inputs - The request body.
 * @returns An error message, or an empty string when the inputs are usable.
 */
async function validateCardanoInputs(inputs: MakeCardanoTransactionInputs): Promise<string> {
  const { channel_user_id, to, amount } = inputs;

  if (!channel_user_id || !to || !amount) return 'One or more fields are empty';

  if (amount.includes(',')) {
    return 'Invalid amount format: use "." (point) as the decimal separator (no commas allowed)';
  }

  // Only the shape is checked here. How many decimals the amount may carry depends on the asset,
  // and the asset is resolved from the database further down — validating against ADA's six here
  // would reject a legitimate amount of a token with a different scale.
  if (!/^\d+(\.\d+)?$/.test(amount.trim())) {
    return 'Amount must contain only digits and optionally a single decimal point';
  }

  if (await areSamePhoneNumber(channel_user_id.trim(), to.trim())) {
    return 'You cannot send money to yourself';
  }

  return '';
}

/**
 * Handles a Cardano transfer request.
 *
 * Mirrors `makeTransaction`'s contract exactly, including the parts that look odd out of context:
 * validation failures answer 200 with a message, because the caller is a chat bot that displays the
 * body to the user, and an HTTP error would surface as "something went wrong" instead.
 *
 * @param request - Fastify request.
 * @param reply - Fastify reply.
 */
export const makeCardanoTransaction = async (
  request: FastifyRequest<{
    Body: MakeCardanoTransactionInputs;
    Querystring?: { lastBotMsgDelaySeconds?: number };
  }>,
  reply: FastifyReply
): Promise<undefined> => {
  const { channel_user_id, to, amount, user_notes } = request.body;
  const tokenSymbol = (request.body.token ?? ADA_SYMBOL).trim() || ADA_SYMBOL;
  const lastBotMsgDelaySeconds = request.query?.lastBotMsgDelaySeconds || 0;
  const logKey = `[op:transfer:cardano:${channel_user_id || ''}:${to}:${amount}:${tokenSymbol}]`;
  const config = getCardanoConfig();

  try {
    /* 1. inputs */
    if (!config.enabled) {
      // The code says which piece is missing, and it stays in the log: the answer the caller
      // displays must not describe this deployment's configuration.
      Logger.warn(
        'makeCardanoTransaction',
        logKey,
        `cardano unavailable: ${config.disabledReason}`
      );
      await returnErrorResponseAsSuccess(
        'makeCardanoTransaction',
        logKey,
        reply,
        'Error making transaction',
        false,
        channel_user_id,
        'Cardano is not available right now'
      );
      return undefined;
    }

    const validationError = await validateCardanoInputs(request.body);
    if (validationError) {
      await returnErrorResponseAsSuccess(
        'makeCardanoTransaction',
        logKey,
        reply,
        'Error making transaction',
        false,
        channel_user_id,
        validationError
      );
      return undefined;
    }

    /* 2. the sender must already be a ChatterPay user */
    const fromUser: IUser | null = await getUser(channel_user_id);
    if (!fromUser) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.wallet_not_created
      );
      Logger.info('makeCardanoTransaction', logKey, message);
      await returnSuccessResponse(reply, message);
      return undefined;
    }

    /* 3. one operation at a time — on Cardano this is what keeps two transfers from selecting the
          same UTxOs. There is no nonce to fall back on. */
    if (hasUserAnyOperationInProgress(fromUser)) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.concurrent_operation
      );
      await persistNotification(channel_user_id, message, NotificationEnum.concurrent_operation);
      Logger.log('makeCardanoTransaction', logKey, 'Concurrent operation in progress');
      await returnSuccessResponse(reply, message);
      return undefined;
    }

    /* 3.1 security gate */
    const operationGate = await securityService.getOperationGate(channel_user_id);
    if (!operationGate.allowed) {
      await returnSuccessResponse(reply, 'Security verification required', {
        allowed: false,
        required_flow: operationGate.required_flow,
        reason: operationGate.reason,
        blocked_until: operationGate.blocked_until
      });
      return undefined;
    }

    /* 4. daily operation limit — read from the Cardano network document */
    const cardanoNetwork = await mongoBlockchainService.getBlockchain(config.chainId);
    if (!cardanoNetwork) {
      Logger.error(
        'makeCardanoTransaction',
        logKey,
        `No blockchain document for ${config.chainId}`
      );
      await returnSuccessResponse(reply, 'Cardano is not configured on this environment');
      return undefined;
    }

    if (await userReachedOperationLimit(cardanoNetwork, channel_user_id, 'transfer')) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.daily_limit_reached
      );
      await persistNotification(channel_user_id, message, NotificationEnum.daily_limit_reached);
      Logger.info('makeCardanoTransaction', logKey, message);
      await returnSuccessResponse(reply, message);
      return undefined;
    }

    /* 5. per-amount limits for ADA */
    const limitsResult = await userWithinTokenOperationLimits(
      channel_user_id,
      'transfer',
      tokenSymbol,
      config.chainId,
      Number(amount)
    );
    if (!limitsResult.isWithinLimits) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.amount_outside_limits
      );
      const formatted = message
        .replace('[LIMIT_MIN]', String(limitsResult.min ?? ''))
        .replace('[LIMIT_MAX]', String(limitsResult.max ?? ''));
      await persistNotification(channel_user_id, formatted, NotificationEnum.amount_outside_limits);
      Logger.info('makeCardanoTransaction', logKey, formatted);
      await returnSuccessResponse(reply, formatted);
      return undefined;
    }

    /* 5.1 can the wallet actually afford it?
       Asked here, not inside the transfer: the chain's own floors -- min-ADA on every output, the
       fee coming out of the inputs, the ADA a token drags with it -- used to surface after the
       lock was open and the user had already been told the operation was in progress. */
    const senderAddress = deriveCardanoAccount(fromUser.phone_number).address;
    const resolved = await resolveCardanoToken(tokenSymbol, config.chainId);
    // Priced here as well as inside the transfer, because it moves the floor: what reaches the
    // destination is the amount less this, and a preflight that ignored it would wave through a
    // transfer the builder then refuses.
    const feeConfig = getCardanoFeeConfig();
    const estimatedChatterPayFee =
      feeConfig.sponsorNetworkFee && chargesTransferFee(feeConfig)
        ? await chatterPayFeeUnits(feeConfig.transferFeeUsd, resolved.symbol, resolved.decimals)
        : 0n;
    const preflight = await canAffordCardanoTransfer(
      senderAddress,
      amount,
      resolved.decimals,
      resolved.asset,
      estimatedChatterPayFee
    );
    if (!preflight.ok) {
      await persistNotification(
        channel_user_id,
        preflight.message,
        NotificationEnum.user_balance_not_enough
      );
      Logger.info('makeCardanoTransaction', logKey, `Preflight rejected: ${preflight.message}`);
      await returnSuccessResponse(reply, preflight.message);
      return undefined;
    }

    /* 5.2 can ChatterPay still cover the network fee?
       Asked before the lock for the same reason as the balance: an empty sponsor wallet is nothing
       the user can act on, and finding out inside the transfer means telling them the operation is
       in progress and then never mentioning it again. */
    const sponsor = await sponsorCanCoverFee(logKey);
    if (!sponsor.ok) {
      await persistNotification(channel_user_id, sponsor.message, NotificationEnum.internal_error);
      await returnSuccessResponse(reply, sponsor.message);
      return undefined;
    }

    /* 6. take the lock and answer optimistically, as the EVM path does */
    await openOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
    const { message: inProgressMessage } = await getNotificationTemplate(
      fromUser.phone_number,
      NotificationEnum.operation_in_progress
    );
    await returnSuccessResponse(reply, inProgressMessage);

    /* 7. the transfer itself. Balance, destination and fee are all checked inside, before any
          signature — Cardano offers no way to cancel a submitted transaction. */
    const result = await executeCardanoOperation({
      fromUser,
      to,
      amount,
      token: tokenSymbol,
      logKey
    });

    if (!result.success) {
      await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      Logger.error('makeCardanoTransaction', logKey, `${result.errorCode}: ${result.error}`);

      // Sent, not merely persisted. The optimistic answer at step 6 already used up the reply, so
      // a row in `notifications` is the whole of what the user would ever see — which is silence.
      if (result.errorCode === 'CARDANO_INSUFFICIENT_FUNDS') {
        // The text sent is the service's own, not a template: it names the address to fund, the
        // only remedy. The generic `user_balance_not_enough` template cannot say that, because on
        // Cardano the wallet the user has to fund is one the product never had to mention before.
        if (lastBotMsgDelaySeconds > 0) await delaySeconds(lastBotMsgDelaySeconds);
        const { title } = await getNotificationTemplate(
          channel_user_id,
          NotificationEnum.user_balance_not_enough
        );
        await persistAndSendNotification({
          to: channel_user_id,
          messageBot: result.error,
          messagePush: result.error,
          template: NotificationEnum.user_balance_not_enough,
          sendPush: true,
          sendBot: true,
          title
        });
      } else {
        // Everything else is an incident: the template is the same one the EVM path sends, and the
        // detail stays in the log above rather than travelling to somebody waiting on a transfer.
        await sendInternalErrorNotification(channel_user_id, lastBotMsgDelaySeconds);
      }
      return undefined;
    }

    /* 8. persist. `fee` is ChatterPay's fee, in the same token as `amount` and already deducted
          from it — so `amount - fee` is what reached the destination, exactly as on EVM.
          `network_fee` is what the chain charged, covered by the sponsor when sponsoring is on. */
    const networkFeeAda = Number(result.networkFeeAda);
    const chatterPayFee = Number(result.chatterPayFee);
    const transactionOut: TransactionData = {
      tx: result.transactionHash,
      walletFrom: result.fromAddress,
      walletTo: result.toAddress,
      amount: Number(amount),
      fee: chatterPayFee,
      token: result.tokenSymbol,
      type: 'transfer',
      status: 'completed',
      chain_id: config.chainId,
      user_notes: user_notes ?? '',
      network_fee: networkFeeAda,
      // Always ADA, whatever moved: Cardano charges its fee in the chain's own coin, so a USDM
      // transfer still pays in ADA.
      network_fee_token: ADA_SYMBOL,
      // Only on a token transfer, where the ADA that left is the minimum the ledger makes travel
      // with the token. On an ADA transfer it is the amount itself and would say nothing.
      attached_ada: resolved.isAda ? undefined : Number(result.sentAda)
    };
    await mongoTransactionService.saveTransaction(transactionOut);

    /* 9. chatterpoints */
    let chatterpointsOpResult: RegisterOperationResult | null = null;
    try {
      chatterpointsOpResult = await chatterpointsService.registerOperation({
        userId: fromUser.phone_number,
        userLevel: fromUser.level,
        type: ConcurrentOperationsEnum.Transfer,
        amount: Number(amount),
        operationId: result.transactionHash
      });
    } catch (error) {
      // Points are a reward, not part of the transfer. The money already moved.
      Logger.error('makeCardanoTransaction', logKey, `Chatterpoints failed: ${String(error)}`);
    }
    await mongoUserService.updateUserOperationCounter(channel_user_id, 'transfer');

    /* 10. release the lock, then notify */
    await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);

    if (lastBotMsgDelaySeconds > 0) {
      await delaySeconds(lastBotMsgDelaySeconds);
    }

    const displayAmount = Number(amount).toFixed(2);
    await sendOutgoingTransferNotification(
      fromUser.phone_number,
      result.toUser?.phone_number ?? result.toAddress,
      result.toUser?.name ?? '',
      displayAmount,
      result.tokenSymbol,
      user_notes ?? '',
      result.transactionHash,
      chatterpointsOpResult,
      undefined,
      // Without this the notification would link a real Cardano hash to the EVM explorer.
      config.explorerUrl
    );

    if (result.toUser) {
      await sendReceivedTransferNotification(
        fromUser.phone_number,
        fromUser.name,
        result.toUser.phone_number,
        displayAmount,
        result.tokenSymbol,
        user_notes ?? ''
      );
    }

    Logger.info(
      'makeCardanoTransaction',
      logKey,
      `Completed: ${result.transactionHash}, network fee ${result.networkFeeAda} ADA, ${result.explorerUrl}`
    );
    return undefined;
  } catch (error) {
    Logger.error('makeCardanoTransaction', logKey, error);

    // The caller is a bot: a request that ends without a body leaves the conversation waiting
    // forever, which is worse than any error text. Everything below the optimistic answer has
    // already replied, so this only fires for a failure on the way there -- but that is exactly the
    // case that used to return nothing at all.
    if (!reply.sent) {
      await returnErrorResponseAsSuccess(
        'makeCardanoTransaction',
        logKey,
        reply,
        'We could not process the transfer. Please try again in a few minutes.',
        false,
        channel_user_id,
        // The code and nothing else: the full text is already in the log above, and an unexpected
        // error's message is written for an operator, not for the person waiting on a transfer.
        cardanoErrorCode(error)
      );
    }

    try {
      const fromUser = await getUser(channel_user_id);
      if (fromUser) {
        await closeOperation(fromUser.phone_number, ConcurrentOperationsEnum.Transfer);
      }
    } catch (closeError) {
      // A lock that cannot be released is worse than the original failure: the user is stuck until
      // it expires. Logged loudly rather than swallowed.
      Logger.error(
        'makeCardanoTransaction',
        logKey,
        `Failed to release lock: ${String(closeError)}`
      );
    }
    return undefined;
  }
};
