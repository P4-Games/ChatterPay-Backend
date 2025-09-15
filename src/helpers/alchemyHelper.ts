/**
 * Alchemy webhook utility functions
 */

/**
 * Converts an Ethereum address to a 32-byte topic format (left-padded with zeros)
 * @param addr - The Ethereum address (with or without 0x prefix)
 * @returns The 32-byte topic string
 */
export const toTopicAddress = (addr: string): string => {
  const cleanAddr = addr.toLowerCase().replace(/^0x/, '');
  return '0x' + '0'.repeat(24) + cleanAddr;
};

/**
 * Extracts an Ethereum address from a 32-byte topic (removes left padding)
 * @param topic - The 32-byte topic string
 * @returns The Ethereum address with 0x prefix
 */
export const fromTopicAddress = (topic: string): string => {
  const cleanTopic = topic.replace(/^0x/, '');
  return '0x' + cleanTopic.slice(-40);
};

/**
 * Validates if a string is a valid Ethereum address
 * @param addr - The address to validate
 * @returns True if valid, false otherwise
 */
export const isValidAddress = (addr: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
};

/**
 * Normalizes an Ethereum address to lowercase with 0x prefix
 * @param addr - The address to normalize
 * @returns The normalized address
 */
export const normalizeAddress = (addr: string): string => {
  if (!isValidAddress(addr)) {
    throw new Error(`Invalid Ethereum address: ${addr}`);
  }
  return addr.toLowerCase();
};
