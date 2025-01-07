/**
 * Function that validates if a given input is a phone number
 *
 * @param input
 * @returns
 */
export function isValidPhoneNumber(input: string): boolean {
  // Remove any non-digit characters
  const cleanedInput = input.replace(/\D/g, '');

  // Check if the cleaned input is between 10 and 15 digits
  if (cleanedInput.length < 10 || cleanedInput.length > 15) {
    return false;
  }

  // Check if the input starts with a valid country code (1-3 digits)
  const countryCodePattern = /^[1-9]\d{0,2}/;
  if (!countryCodePattern.test(cleanedInput)) {
    return false;
  }

  // Additional checks can be added here for specific country formats if needed
  return true;
}
