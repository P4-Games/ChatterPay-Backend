/**
 * Get phone number formatted by removing all non-numeric characters.
 * @param phone The phone number string that may contain symbols, spaces, or other non-numeric characters.
 * @returns A string containing only the numeric digits from the phone number.
 */
import { mongoCountryService } from '../services/mongo/mongoCountryService';

export function getPhoneNumberFormatted(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Formats an identifier (phone number or address) with an optional name and masking.
 *
 * @param identifier - The identifier (phone number or address) to be displayed.
 * @param name - The name to be included with the identifier (optional).
 * @param maskIdentifier - If true, masks part of the identifier for privacy.
 * @returns A string containing the identifier (masked if applicable), optionally concatenated with the name in parentheses.
 */
export function formatIdentifierWithOptionalName(
  identifier: string,
  name?: string | null,
  maskIdentifier?: boolean
): string {
  let formattedIdentifier = identifier;

  if (maskIdentifier) {
    // Special handling for blockchain addresses
    if (formattedIdentifier.startsWith('0x')) {
      formattedIdentifier = `${identifier.slice(0, 4)}xxxx${identifier.slice(-4)}`;
    } else {
      // Mask the last 5 digits if maskIdentifier is true
      formattedIdentifier = `${identifier.slice(0, identifier.length - 5)}xxxxx`;
    }
  }

  return name ? `${formattedIdentifier} (${name})` : formattedIdentifier;
}

/**
 * Normalizes a phone number and returns possible variants for lookup.
 * Detects the country dynamically from DB (using phone_code prefix).
 * Strips all non-digits and handles regional quirks (e.g. AR, MX).
 *
 * @param phone - Raw phone number (may include +, spaces, or symbols)
 * @returns Array of numeric strings (no '+', spaces or formatting)
 */
export async function getPhoneNumberVariants(phone: string): Promise<string[]> {
  if (!phone) return [];

  const digits = phone.replace(/\D/g, '');
  if (!digits) return [];

  // Detect the country from the number prefix (DB lookup)
  const country = await mongoCountryService.getCountryByPhoneNumber(digits);
  const code = country?.code?.toUpperCase() ?? null;

  const variants = new Set<string>([digits]);

  switch (code) {
    case 'AR': {
      // Argentina: optional "9" after 54
      if (/^549/.test(digits))
        variants.add(digits.replace(/^549/, '54')); // remove 9
      else if (/^54(?!9)/.test(digits)) variants.add(digits.replace(/^54/, '549')); // add 9
      break;
    }

    case 'MX': {
      // Mexico: optional "1" after 52
      if (/^521/.test(digits))
        variants.add(digits.replace(/^521/, '52')); // remove 1
      else if (/^52(?!1)/.test(digits)) variants.add(digits.replace(/^52/, '521')); // add 1
      break;
    }

    default:
      // No regional quirks
      break;
  }

  return Array.from(variants);
}

/**
 * Converts a raw on-chain token amount (big integer string) into a human-readable decimal value.
 *
 * This helper divides the raw integer representation (e.g. wei, smallest token unit)
 * by `10 ** decimals` to obtain the standard user-facing numeric amount.
 * Use this only for display or lightweight arithmetic, as large values may lose precision in JS `number`.
 *
 * @param {string} rawValue - The raw integer amount as a string (e.g. "1000000000000000000").
 * @param {number} decimals - Number of decimals the token uses (e.g. 18 for ETH/USDT).
 * @returns {number} The value expressed in whole tokens with decimals applied.
 */
export const formatTokenAmount = (rawValue: string, decimals: number): number => {
  const divisor = 10 ** decimals;
  return Number(rawValue) / divisor;
};

/**
 * Checks whether two phone numbers represent the same destination.
 *
 * It compares:
 * 1) Exact match across normalized variants (handles regional quirks like AR 54/549, MX 52/521).
 * 2) Suffix match for cases where one side is missing the country code (e.g. local numbers).
 *
 * @param {string} a - First phone number (raw; may include +, spaces, symbols).
 * @param {string} b - Second phone number (raw; may include +, spaces, symbols).
 * @returns {Promise<boolean>} True if both inputs likely refer to the same phone number.
 */
export async function areSamePhoneNumber(a: string, b: string): Promise<boolean> {
  const aDigits = getPhoneNumberFormatted(a ?? '');
  const bDigits = getPhoneNumberFormatted(b ?? '');

  if (!aDigits || !bDigits) return false;

  const aVariants = new Set<string>(await getPhoneNumberVariants(aDigits));
  const bVariants = new Set<string>(await getPhoneNumberVariants(bDigits));

  // 1) Exact match across variants
  for (const v of aVariants) {
    if (bVariants.has(v)) return true;
  }

  // 2) Suffix match (handles missing country code)
  const suffixLengths: readonly number[] = [10, 11];

  const aSuffixes = buildSuffixSet(aVariants, suffixLengths);
  const bSuffixes = buildSuffixSet(bVariants, suffixLengths);

  for (const s of aSuffixes) {
    if (bSuffixes.has(s)) return true;
  }

  return false;
}

/**
 * Builds a set of suffixes (last N digits) from the given phone variants.
 *
 * @param {ReadonlySet<string>} variants - Phone variants as digit-only strings.
 * @param {readonly number[]} lengths - Suffix lengths to include (e.g. 10, 11).
 * @returns {Set<string>} Set containing suffixes extracted from all variants.
 */
function buildSuffixSet(variants: ReadonlySet<string>, lengths: readonly number[]): Set<string> {
  const out = new Set<string>();

  for (const v of variants) {
    for (const len of lengths) {
      if (v.length >= len) out.add(v.slice(-len));
    }
  }

  return out;
}

/**
 * Normalizes a phone number and returns possible variants for lookup.
 * Detects the country dynamically from DB (using phone_code prefix).
 * Strips all non-digits and handles regional quirks (e.g. AR, MX).
 *
 * @param phone - Raw phone number (may include +, spaces, or symbols)
 * @returns Array of numeric strings (no '+', spaces or formatting)
 */
export async function getPhoneNumberVariants(phone: string): Promise<string[]> {
  if (!phone) return [];

  const digits = phone.replace(/\D/g, '');
  if (!digits) return [];

  // Detect the country from the number prefix (DB lookup)
  const country = await mongoCountryService.getCountryByPhoneNumber(digits);
  const code = country?.code?.toUpperCase() ?? null;

  const variants = new Set<string>([digits]);

  switch (code) {
    case 'AR': {
      // Argentina: optional "9" after 54
      if (/^549/.test(digits))
        variants.add(digits.replace(/^549/, '54')); // remove 9
      else if (/^54(?!9)/.test(digits)) variants.add(digits.replace(/^54/, '549')); // add 9
      break;
    }

    case 'MX': {
      // Mexico: optional "1" after 52
      if (/^521/.test(digits))
        variants.add(digits.replace(/^521/, '52')); // remove 1
      else if (/^52(?!1)/.test(digits)) variants.add(digits.replace(/^52/, '521')); // add 1
      break;
    }

    default:
      // No regional quirks
      break;
  }

  return Array.from(variants);
}

/**
 * Converts a raw on-chain token amount (big integer string) into a human-readable decimal value.
 *
 * This helper divides the raw integer representation (e.g. wei, smallest token unit)
 * by `10 ** decimals` to obtain the standard user-facing numeric amount.
 * Use this only for display or lightweight arithmetic, as large values may lose precision in JS `number`.
 *
 * @param {string} rawValue - The raw integer amount as a string (e.g. "1000000000000000000").
 * @param {number} decimals - Number of decimals the token uses (e.g. 18 for ETH/USDT).
 * @returns {number} The value expressed in whole tokens with decimals applied.
 */
export const formatTokenAmount = (rawValue: string, decimals: number): number => {
  const divisor = 10 ** decimals;
  return Number(rawValue) / divisor;
};
