/**
 * Delays the execution for a specified number of seconds.
 *
 * @param {number} seconds - The number of seconds to wait before resolving.
 * @returns {Promise<void>} A promise that resolves after the specified delay.
 */
export const delaySeconds = (seconds: number): Promise<void> => {
  const MAX_TIMEOUT_MS = 2_147_483_647; // ~24.8 days
  const ms = seconds * 1000;
  const clamped = Math.min(ms, MAX_TIMEOUT_MS);

  return new Promise((resolve) => {
    setTimeout(resolve, clamped);
  });
};

/**
 * Create a Date object normalized to UTC from the current local time.
 *
 * @returns {Date} Current time expressed in UTC.
 */
export function newDateUTC(): Date {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000);
}
