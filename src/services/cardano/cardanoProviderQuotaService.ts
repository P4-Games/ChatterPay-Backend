/**
 * The provider's daily quota, shared by every consumer of the credential in this backend.
 *
 * The plan's limit is per credential and per day, and it is spent by everything: balances, transfer
 * quotes and confirmations, the staking screen and the sweep. A ceiling on the sweep alone
 * (`maxProviderRequestsPerRun`) cannot keep the total under the plan, so every request is reserved
 * here, in Mongo, before it is sent — across Cloud Run instances, with a conditional `$inc` whose
 * filter is the limit. An in-process counter would give each instance its own quota.
 *
 * Limits by priority (see `CardanoProviderPriority`):
 *
 * - `critical` (submissions) is counted and never refused. The provider enforces its own limit; a
 *   refusal here would only turn a signed transaction into an `unknown_submit`.
 * - `interactive` and `pending` stop at `dailyLimit - criticalReserve`, leaving the reserve to
 *   submissions.
 * - `background` stops at the same line, and also at `backgroundDailyLimit` of its own, and pauses
 *   after a 429 for as long as `Retry-After` says (60 seconds when it says nothing). What background
 *   does not spend stays available to the others; the difference between the two limits is the
 *   interactive reserve.
 *
 * A reserved request is never given back, including when its answer never arrived: whether the
 * provider counted it is unknown, and assuming it did not is how a quota is overrun. The count is
 * therefore an upper bound on this backend's usage, and a lower bound on the credential's usage when
 * anything outside this backend shares it.
 *
 * When the counter cannot be written, `background` is refused and every other priority proceeds and
 * logs: an outage of the meter must not take balances and confirmations down with it.
 */

import { createHash } from 'node:crypto';

import { getCardanoConfig } from '../../config/cardanoConfig';
import { Logger } from '../../helpers/loggerHelper';
import CardanoProviderQuota, {
  type ICardanoProviderQuota
} from '../../models/cardanoProviderQuotaModel';
import { mongoBlockchainService } from '../mongo/mongoBlockchainService';
import {
  type CardanoProviderCallMeta,
  type CardanoProviderMeter,
  type CardanoProviderPriority,
  CardanoProviderQuotaError,
  setCardanoProviderMeter
} from './cardanoProviderService';

/** The quota a credential runs under, as configured on its network. */
export interface ProviderQuotaLimits {
  dailyLimit: number;
  backgroundDailyLimit: number;
  criticalReserve: number;
  /** Minutes after 00:00 UTC at which the provider's day starts. */
  dayStartOffsetMinutes: number;
}

/** What a network without the fields runs under. Starting values, to be tuned from measurements. */
export const DEFAULT_PROVIDER_QUOTA_LIMITS: ProviderQuotaLimits = {
  dailyLimit: 50_000,
  backgroundDailyLimit: 20_000,
  criticalReserve: 1_000,
  dayStartOffsetMinutes: 0
};

/** Share of the daily limit at which a warning is logged, once per crossing. */
const WARNING_SHARES = [0.8, 0.95] as const;

/** How long background work pauses after a 429 that carried no `Retry-After`. */
const DEFAULT_PAUSE_SECONDS = 60;

/** How long configured limits are reused before the network document is read again. */
const LIMITS_TTL_MS = 60 * 1000;

/**
 * Names a credential without revealing it.
 *
 * @param baseUrl - The provider root, which says which provider and which network.
 * @param credential - The key, or empty.
 * @returns `<kind>:<host>:<fingerprint>`. The fingerprint is twelve hex characters of a SHA-256 of
 *   the key: enough to tell two keys apart, useless for recovering one.
 */
export function quotaScope(baseUrl: string, credential: string): string {
  let host = 'unknown-host';
  try {
    host = new URL(baseUrl).host;
  } catch {
    // An unparseable root still gets a scope of its own rather than sharing one.
  }
  const kind = host.endsWith('blockfrost.io') ? 'blockfrost' : 'koios';
  const fingerprint =
    credential === ''
      ? 'nokey'
      : createHash('sha256').update(credential).digest('hex').slice(0, 12);
  return `${kind}:${host}:${fingerprint}`;
}

/**
 * The quota day a moment falls in.
 *
 * @param now - The moment.
 * @param offsetMinutes - Minutes after 00:00 UTC at which the provider's day starts.
 * @returns `YYYY-MM-DD`.
 */
export function quotaWindow(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() - offsetMinutes * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The endpoint family of a path, with every identifier removed.
 *
 * @param path - The request path, query included.
 * @returns E.g. `accounts:rewards` for `/accounts/stake1…/rewards?page=2`. Segments holding digits or
 *   longer than 24 characters are identifiers — addresses, hashes, pool ids — and are dropped, so no
 *   address reaches the metrics.
 */
export function providerFamily(path: string): string {
  const segments = (path.split('?')[0] ?? '')
    .split('/')
    .filter((segment) => /^[a-z_]+$/.test(segment) && segment.length <= 24);
  return segments.length === 0 ? 'root' : segments.join(':');
}

/**
 * The filter under which a reservation of this priority is allowed.
 *
 * @param id - The quota document.
 * @param priority - The request's priority.
 * @param limits - The configured limits.
 * @param now - The clock, for the post-429 pause.
 * @returns The filter. A document that does not match it makes the upsert collide, which is the
 *   refusal.
 */
function reservationFilter(
  id: string,
  priority: CardanoProviderPriority,
  limits: ProviderQuotaLimits,
  now: Date
): Record<string, unknown> {
  if (priority === 'critical') return { _id: id };
  const shared = limits.dailyLimit - limits.criticalReserve;
  if (priority !== 'background') return { _id: id, total: { $lt: shared } };
  return {
    _id: id,
    total: { $lt: shared },
    $and: [
      {
        $or: [
          { 'byPriority.background': { $exists: false } },
          { 'byPriority.background': { $lt: limits.backgroundDailyLimit } }
        ]
      },
      { $or: [{ backgroundPausedUntil: null }, { backgroundPausedUntil: { $lte: now } }] }
    ]
  };
}

/**
 * A meter backed by the shared Mongo counter.
 *
 * @param options - Where the limits come from, and the clock.
 * @returns The meter.
 */
export function createMongoProviderMeter(options: {
  limits: () => Promise<ProviderQuotaLimits>;
  now?: () => Date;
}): CardanoProviderMeter {
  const clock = options.now ?? (() => new Date());

  return {
    async reserve(meta: CardanoProviderCallMeta): Promise<void> {
      const now = clock();
      const limits = await options.limits();
      const scope = quotaScope(meta.baseUrl, meta.credential);
      const window = quotaWindow(now, limits.dayStartOffsetMinutes);
      const id = `${scope}|${window}`;

      // A conditional update without upsert: the filter is the limit, and no match means no room.
      // An upsert whose filter carries a condition cannot be used for this: under concurrency the
      // losing writers collide on `_id` and a duplicate key is indistinguishable from "limit reached",
      // which refused requests with the quota nowhere near spent. So the document is created on its
      // own, by an upsert filtered on `_id` alone (which the server retries on collision), and only
      // then is a miss read as a refusal.
      const reserve = (): Promise<Pick<ICardanoProviderQuota, 'total'> | null> =>
        CardanoProviderQuota.findOneAndUpdate(
          reservationFilter(id, meta.priority, limits, now),
          {
            $inc: {
              total: 1,
              [`byPriority.${meta.priority}`]: 1,
              [`byFamily.${providerFamily(meta.path)}`]: 1,
              [`byOrigin.${meta.origin.replace(/[.$]/g, '_')}`]: 1
            },
            $set: { updatedAt: now }
          },
          { new: true, projection: { total: 1 } }
        ).lean<Pick<ICardanoProviderQuota, 'total'> | null>();

      let reserved: Pick<ICardanoProviderQuota, 'total'> | null;
      try {
        reserved = await reserve();
        if (reserved === null) {
          await CardanoProviderQuota.updateOne(
            { _id: id },
            { $setOnInsert: { scope, window, createdAt: now, total: 0 } },
            { upsert: true }
          );
          reserved = await reserve();
        }
        if (reserved === null) {
          const refusal = meta.priority === 'background' ? 'background' : 'daily';
          await CardanoProviderQuota.updateOne(
            { _id: id },
            { $inc: { [`refused.${refusal}`]: 1 } }
          ).catch(() => undefined);
          throw new CardanoProviderQuotaError(
            refusal,
            `CARDANO_PROVIDER_QUOTA: ${meta.priority} request refused, ${refusal} limit reached`
          );
        }
      } catch (error) {
        if (error instanceof CardanoProviderQuotaError) throw error;
        if (meta.priority === 'background') {
          throw new CardanoProviderQuotaError(
            'meter_unavailable',
            `CARDANO_PROVIDER_QUOTA_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        Logger.warn(
          'providerQuota',
          `Provider quota could not be recorded; ${meta.priority} request proceeds uncounted`
        );
        return;
      }

      const total = reserved?.total ?? 0;
      for (const share of WARNING_SHARES) {
        if (total === Math.floor(limits.dailyLimit * share)) {
          Logger.warn(
            'providerQuota',
            `Provider quota ${scope} at ${Math.round(share * 100)}% (${total}/${limits.dailyLimit}) for ${window}`
          );
        }
      }
    },

    async rateLimited(meta: CardanoProviderCallMeta, retryAfter: number | null): Promise<void> {
      const now = clock();
      try {
        const limits = await options.limits();
        const scope = quotaScope(meta.baseUrl, meta.credential);
        const window = quotaWindow(now, limits.dayStartOffsetMinutes);
        await CardanoProviderQuota.updateOne(
          { _id: `${scope}|${window}` },
          {
            $inc: { rateLimited: 1 },
            $set: {
              updatedAt: now,
              backgroundPausedUntil: new Date(
                now.getTime() + (retryAfter ?? DEFAULT_PAUSE_SECONDS) * 1000
              )
            },
            $setOnInsert: { scope, window, createdAt: now, total: 0 }
          },
          { upsert: true }
        );
      } catch (error) {
        // The 429 itself still reaches the caller; losing the count is the lesser failure.
        Logger.warn(
          'providerQuota',
          `Could not record a provider 429: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
}

/**
 * Reads the quota a network's credential runs under.
 *
 * @param chainId - The network.
 * @returns The limits, with defaults for any field the document lacks or holds unusably.
 */
export async function loadProviderQuotaLimits(chainId: number): Promise<ProviderQuotaLimits> {
  const staking = (await mongoBlockchainService.getBlockchain(chainId))?.staking;
  const read = (raw: unknown, fallback: number): number =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  return {
    dailyLimit: read(staking?.providerDailyRequestLimit, DEFAULT_PROVIDER_QUOTA_LIMITS.dailyLimit),
    backgroundDailyLimit: read(
      staking?.providerBackgroundDailyLimit,
      DEFAULT_PROVIDER_QUOTA_LIMITS.backgroundDailyLimit
    ),
    criticalReserve: read(
      staking?.providerCriticalReserve,
      DEFAULT_PROVIDER_QUOTA_LIMITS.criticalReserve
    ),
    dayStartOffsetMinutes: read(
      staking?.providerQuotaDayStartOffsetMinutes,
      DEFAULT_PROVIDER_QUOTA_LIMITS.dayStartOffsetMinutes
    )
  };
}

/**
 * Installs the shared meter for this deployment's Cardano network.
 *
 * The limits are re-read at most once a minute: a change to the network document takes effect within
 * that, and a burst of requests does not become a burst of reads of the same document. The counter
 * itself is never cached.
 */
export function installCardanoProviderMeter(): void {
  let cached: { limits: ProviderQuotaLimits; at: number } | null = null;
  setCardanoProviderMeter(
    createMongoProviderMeter({
      limits: async () => {
        if (cached !== null && Date.now() - cached.at < LIMITS_TTL_MS) return cached.limits;
        try {
          const limits = await loadProviderQuotaLimits(getCardanoConfig().chainId);
          cached = { limits, at: Date.now() };
          return limits;
        } catch {
          return cached?.limits ?? DEFAULT_PROVIDER_QUOTA_LIMITS;
        }
      }
    })
  );
}

/** One day's usage of a credential, for reports. No address, key or user appears in it. */
export interface ProviderUsageSnapshot {
  scope: string;
  window: string;
  limits: ProviderQuotaLimits;
  total: number;
  /** What interactive and pending work may still spend today. */
  remainingShared: number;
  /** What background work may still spend today, the smaller of its own and the shared remainder. */
  remainingBackground: number;
  byPriority: Record<string, number>;
  byFamily: Record<string, number>;
  byOrigin: Record<string, number>;
  rateLimited: number;
  refused: Record<string, number>;
  backgroundPausedUntil: Date | null;
  /**
   * What the figures measure. Only requests sent by this backend are counted; another consumer of
   * the same credential makes the true usage higher than `total`.
   */
  coverage: 'backend_requests_only';
}

/**
 * Today's usage of the configured credential.
 *
 * @param chainId - The network whose limits apply.
 * @param now - The clock.
 * @returns The snapshot.
 */
export async function providerUsageSnapshot(
  chainId: number,
  now: Date = new Date()
): Promise<ProviderUsageSnapshot> {
  const config = getCardanoConfig();
  const limits = await loadProviderQuotaLimits(chainId);
  const scope = quotaScope(config.providerUrl, config.providerApiKey);
  const window = quotaWindow(now, limits.dayStartOffsetMinutes);
  const stored = await CardanoProviderQuota.findById(
    `${scope}|${window}`
  ).lean<ICardanoProviderQuota | null>();

  const total = stored?.total ?? 0;
  const background = stored?.byPriority?.background ?? 0;
  const remainingShared = Math.max(0, limits.dailyLimit - limits.criticalReserve - total);
  return {
    scope,
    window,
    limits,
    total,
    remainingShared,
    remainingBackground: Math.min(
      remainingShared,
      Math.max(0, limits.backgroundDailyLimit - background)
    ),
    byPriority: stored?.byPriority ?? {},
    byFamily: stored?.byFamily ?? {},
    byOrigin: stored?.byOrigin ?? {},
    rateLimited: stored?.rateLimited ?? 0,
    refused: stored?.refused ?? {},
    backgroundPausedUntil: stored?.backgroundPausedUntil ?? null,
    coverage: 'backend_requests_only'
  };
}
