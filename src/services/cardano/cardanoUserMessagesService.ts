/**
 * Turns a Cardano refusal into the sentence the user reads, in the user's own language.
 *
 * The services that decide a transfer cannot happen are arithmetic: floors, fees and balances. They
 * answer with a {@link CardanoRefusal} — a reason and the figures it names — and this is the only
 * place that turns one into words. That split is what the EVM path already does with
 * `amount_outside_limits`: the validator returns `{ min, max }` and the controller renders the
 * localized template. A service that returns prose has picked a language on everybody's behalf, and
 * on a bot where the whole conversation happens in Spanish, that language is the wrong one.
 *
 * The English text below is a **fallback, not the message**. `getNotificationTemplate` answers with
 * an empty string when the template is not in Mongo yet, and an empty chat message is worse than an
 * English one: it reads as the bot ignoring you. So the fallback covers the window between the code
 * being deployed and the templates being loaded, and it is the same wording as the `en` variant.
 */

import { Logger } from '../../helpers/loggerHelper';
import { NotificationEnum } from '../../models/templateModel';
import type { CardanoRefusal, CardanoRefusalReason } from '../../types/cardanoType';
import { getNotificationTemplate } from '../notificationService';

/** Which notification template says each reason. */
const TEMPLATE_FOR: Readonly<Record<CardanoRefusalReason, NotificationEnum>> = {
  amount_below_minimum: NotificationEnum.cardano_amount_below_minimum,
  insufficient_ada: NotificationEnum.cardano_insufficient_ada,
  change_carries_tokens: NotificationEnum.cardano_change_carries_tokens,
  change_below_floor: NotificationEnum.cardano_change_below_floor,
  token_needs_ada: NotificationEnum.cardano_token_needs_ada,
  token_needs_ada_keeping_rest: NotificationEnum.cardano_token_needs_ada_keeping_rest,
  token_change_needs_ada: NotificationEnum.cardano_token_change_needs_ada,
  token_balance_not_enough: NotificationEnum.cardano_token_balance_not_enough,
  amount_below_fee: NotificationEnum.cardano_amount_below_fee,
  sponsor_unavailable: NotificationEnum.cardano_sponsor_unavailable,
  insufficient_funds: NotificationEnum.cardano_insufficient_funds
};

/** The `en` wording of each template, used only while the template itself is missing. */
const FALLBACK_MESSAGE: Readonly<Record<CardanoRefusalReason, string>> = {
  amount_below_minimum:
    'The minimum you can send on Cardano is [MIN_AMOUNT] ADA. [NETWORK_MIN] of it is a network ' +
    'limit, not a ChatterPay one: below that, the transfer fails the whole transaction.',
  insufficient_ada:
    'Not enough balance. To send [AMOUNT] ADA you need [REQUIRED] ADA in your wallet and you ' +
    'have [HELD] ADA.',
  change_carries_tokens:
    'With [HELD] ADA you can send up to [MAX_AMOUNT] ADA. The rest has to stay in your wallet: it ' +
    'holds tokens, and the [CHANGE_FLOOR] ADA that carries them cannot leave with the transfer.',
  change_below_floor:
    'With [HELD] ADA you can send up to [MAX_AMOUNT] ADA, or send it all ([ALL_AMOUNT] ADA). ' +
    'Between those two figures the change falls below the minimum the network requires ' +
    '([CHANGE_FLOOR] ADA) and is lost.',
  token_needs_ada:
    'Sending a Cardano token also takes ADA: the network requires the transfer to carry ' +
    '[ATTACHED] ADA attached. You need [REQUIRED] ADA in your wallet and you have [HELD] ADA.',
  token_needs_ada_keeping_rest:
    'Sending a Cardano token also takes ADA: the network requires the transfer to carry ' +
    '[ATTACHED] ADA attached, and as much again for the change that keeps the rest of the token. ' +
    'You need [REQUIRED] ADA in your wallet and you have [HELD] ADA.',
  token_change_needs_ada:
    'To send part of a token you have to keep the rest in your wallet, and the network requires ' +
    '[CHANGE_FLOOR] ADA to carry it. You have [HELD] ADA. Sending the whole balance needs none.',
  token_balance_not_enough:
    'Not enough balance: you have [HELD] and you are trying to send [AMOUNT].',
  amount_below_fee:
    'The amount has to be more than the [FEE] fee for this transfer, otherwise nothing would ' +
    'reach the destination.',
  sponsor_unavailable:
    'We could not process the transfer right now. Please try again in a few minutes.',
  insufficient_funds:
    'Your Cardano wallet does not have enough ADA for this transfer. Fund this address and try ' +
    'again: [ADDRESS]'
};

/** Replaces every placeholder. `split`/`join` rather than `replace`, because the keys are literal
 *  brackets and a placeholder may appear more than once in a translation. */
function fill(text: string, params: Readonly<Record<string, string>>): string {
  return Object.entries(params).reduce(
    (filled, [placeholder, value]) => filled.split(placeholder).join(value),
    text
  );
}

/** A refusal, said. */
export interface CardanoRefusalMessage {
  /** The title of the notification, from the template. */
  title: string;
  /** The sentence, localized and with its figures in place. */
  message: string;
  /** The template it came from, for the notification row. */
  template: NotificationEnum;
}

/**
 * Says a refusal in the user's language.
 *
 * @param channelUserId - Who is being told. Their settings decide the language.
 * @param refusal - The reason and its figures.
 * @returns The title, the finished sentence, and the template it belongs to.
 */
export async function cardanoRefusalMessage(
  channelUserId: string,
  refusal: CardanoRefusal
): Promise<CardanoRefusalMessage> {
  const template = TEMPLATE_FOR[refusal.reason];
  const { title, message } = await getNotificationTemplate(channelUserId, template);

  if (message.trim() === '') {
    // Worth a warning rather than silence: the fallback is correct English, but a deployment
    // sitting on it is a deployment where every Spanish-speaking user reads English.
    Logger.warn(
      'cardanoRefusalMessage',
      `Notification template ${template} is missing; falling back to the English wording.`
    );
  }

  const text = message.trim() === '' ? FALLBACK_MESSAGE[refusal.reason] : message;
  return { title, message: fill(text, refusal.params), template };
}
