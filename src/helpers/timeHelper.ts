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
