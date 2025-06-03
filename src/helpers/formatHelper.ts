/**
 * Get phone number formatted by removing all non-numeric characters.
 * @param phone The phone number string that may contain symbols, spaces, or other non-numeric characters.
 * @returns A string containing only the numeric digits from the phone number.
 */
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
