/**
 * Get phone number formatted by removing all non-numeric characters.
 * @param phone The phone number string that may contain symbols, spaces, or other non-numeric characters.
 * @returns A string containing only the numeric digits from the phone number.
 */
export function getPhoneNumberFormatted(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Concatenates a phone number with a name if the name is provided.
 *
 * @param phoneNumber - The phone number to be displayed.
 * @param name - The name to be included with the phone number (optional).
 * @returns A string containing the phone number, optionally concatenated with the name in parentheses.
 */
export function formatPhoneNumberWithOptionalName(phoneNumber: string, name?: string): string {
  return name ? `${phoneNumber} (${name})` : phoneNumber;
}
