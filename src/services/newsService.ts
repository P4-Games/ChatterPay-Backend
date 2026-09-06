import { Logger } from '../helpers/loggerHelper';
import type { NewsItemType, NewsTemplatesTypes } from '../models/templateModel';
import type { NotificationLanguage } from '../types/commonType';
import { mongoTemplateService, templateEnum } from './mongo/mongoTemplateService';

/**
 * Surface an announcement can be shown on. The front asks for the one it is rendering.
 */
export type NewsTarget = 'landing' | 'dashboard';

/**
 * Normalizes anything the caller may send as a surface into one the filter understands.
 *
 * Anything else, the parameter missing included, comes back as null, which reads as no filter at
 * all: a caller that does not care about surfaces gets every active announcement.
 *
 * @param target - Raw target value from the request.
 * @returns The surface to filter by, or null to skip the filter.
 */
export function normalizeNewsTarget(target: string | null | undefined): NewsTarget | null {
  const normalized = (target ?? '').trim().toLowerCase();
  if (normalized === 'landing') return 'landing';
  if (normalized === 'dashboard') return 'dashboard';
  return null;
}

/**
 * One announcement already resolved to a single language, as the front consumes it.
 */
export interface LocalizedNewsItem {
  key: string;
  title: string;
  message: string;
  initAt: string;
  endAt: string;
}

/**
 * Normalizes anything the caller may send as a language into one the templates actually carry.
 *
 * The front uses `br` for Portuguese while the templates use `pt`, and browsers send regional tags
 * such as `es-AR`, so a prefix match is what keeps a legitimate visitor from falling back to
 * English.
 *
 * @param language - Raw language value from the request.
 * @returns The template language to read.
 */
export function normalizeNewsLanguage(language: string | null | undefined): NotificationLanguage {
  const normalized = (language ?? '').trim().toLowerCase();
  if (normalized.startsWith('es')) return 'es';
  if (normalized.startsWith('pt') || normalized.startsWith('br')) return 'pt';
  return 'en';
}

/**
 * Decides whether an announcement should be visible on a surface at a given instant.
 *
 * The surface flags are read as "visible unless explicitly turned off", so an announcement stored
 * before the flags existed keeps reaching every surface instead of disappearing from all of them.
 *
 * @param item - The announcement to check.
 * @param now - The instant to evaluate against.
 * @param target - Surface being rendered, or null to ignore the surface flags.
 * @returns True when the item is enabled, allowed on the surface, and `now` falls inside its window.
 */
function isActive(item: NewsItemType, now: Date, target: NewsTarget | null): boolean {
  if (!item || item.enabled === false) return false;

  if (target === 'landing' && item.showInLanding === false) return false;
  if (target === 'dashboard' && item.showInDashboard === false) return false;

  const initAt = item.initAt ? new Date(item.initAt) : null;
  const endAt = item.endAt ? new Date(item.endAt) : null;

  if (initAt && Number.isFinite(initAt.getTime()) && now < initAt) return false;
  if (endAt && Number.isFinite(endAt.getTime()) && now > endAt) return false;

  return true;
}

/**
 * Returns every announcement that is visible right now, resolved to one language.
 *
 * Nothing here is cached. The whole point of holding the window in Mongo is that raising or
 * lowering an announcement takes effect immediately, and a template cache would put a TTL between
 * the operator's edit and what visitors see.
 *
 * Best effort: a missing `news` field, or a read that fails, comes back as an empty list, because a
 * banner is never worth taking a page down for.
 *
 * @param language - Language to resolve the localized fields to.
 * @param target - Surface being rendered. Anything unrecognized returns every active item.
 * @returns The active announcements, ordered by `order` and then by start date.
 */
export async function getActiveNews(
  language: string,
  target?: string | null
): Promise<LocalizedNewsItem[]> {
  const lang = normalizeNewsLanguage(language);
  const surface = normalizeNewsTarget(target);

  try {
    const templates = await mongoTemplateService.getTemplate<NewsTemplatesTypes>(templateEnum.NEWS);
    if (!templates) return [];

    const newsObj = (
      templates instanceof Map ? Object.fromEntries(templates) : templates
    ) as NewsTemplatesTypes;

    const now = new Date();

    return Object.entries(newsObj)
      .filter(([, item]) => isActive(item, now, surface))
      .sort(([keyA, a], [keyB, b]) => {
        const orderDiff = (a.order ?? 0) - (b.order ?? 0);
        if (orderDiff !== 0) return orderDiff;

        const initDiff = new Date(a.initAt).getTime() - new Date(b.initAt).getTime();
        if (initDiff !== 0) return initDiff;

        return keyA.localeCompare(keyB);
      })
      .map(([key, item]) => ({
        key,
        title: item.title?.[lang] || item.title?.en || '',
        message: item.message?.[lang] || item.message?.en || '',
        initAt: new Date(item.initAt).toISOString(),
        endAt: new Date(item.endAt).toISOString()
      }))
      .filter((item) => item.title !== '' || item.message !== '');
  } catch (error: unknown) {
    Logger.error('getActiveNews', 'Failed to read news templates', (error as Error).message);
    return [];
  }
}
