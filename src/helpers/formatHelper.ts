/**
 * Get phone number formatted by removing all non-numeric characters.
 * @param phone The phone number string that may contain symbols, spaces, or other non-numeric characters.
 * @returns A string containing only the numeric digits from the phone number.
 */
export function getPhoneNumberFormatted(phone: string): string {
  return phone.replace(/\D/g, '');
}
