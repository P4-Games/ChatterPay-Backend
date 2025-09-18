/**
 * Delays the execution for a specified number of seconds.
 *
 * @param {number} seconds - The number of seconds to wait before resolving.
 * @returns {Promise<void>} A promise that resolves after the specified delay.
 */
export const delaySeconds = (seconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });

/**
 * Create a Date object normalized to UTC from the current local time.
 *
 * @returns {Date} Current time expressed in UTC.
 */
export function newDateUTC(): Date {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000);
}
