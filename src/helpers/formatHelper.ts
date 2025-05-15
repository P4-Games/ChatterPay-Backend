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
 * Optionally masks the last 5 digits of the phone number.
 *
 * @param phoneNumber - The phone number to be displayed.
 * @param name - The name to be included with the phone number (optional).
 * @param maskPhoneNumber - If true, masks the last 5 digits of the phone number with "*".
 * @returns A string containing the phone number (masked if applicable), optionally concatenated with the name in parentheses.
 */
export function formatPhoneNumberWithOptionalName(
  phoneNumber: string,
  name?: string,
  maskPhoneNumber?: boolean
): string {
  let formattedPhoneNumber = phoneNumber;

  // Mask the last 5 digits if maskPhoneNumber is true
  if (maskPhoneNumber) {
    formattedPhoneNumber = `${phoneNumber.slice(0, phoneNumber.length - 5)}xxxxx`;
  }

  return name ? `${formattedPhoneNumber} (${name})` : formattedPhoneNumber;
}

/**
 * Mask the address with the first 5 and last 4 characters
 * @param address
 * @returns
 */
export function maskAddress(address: string): string {
  return `${address.slice(0, 5)}****${address.slice(-4)}`;
}
