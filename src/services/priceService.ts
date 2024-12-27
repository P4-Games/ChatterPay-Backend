interface CoinData {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
}

/**
 * Gets the price of a token on a network
 * @param contracts Array of token contracts with name and address
 * @param network Network from which prices will be obtained (in lowercase string format)
 * @returns Array, where each element is an array with the token name and its price
 */
export const getPriceByEVMContract = async (
  contracts: [string, string][],
  network: string = 'polygon'
): Promise<[string, number][]> => {
  const contractsAsString = contracts.map((c) => `${network}:${c[1].toLowerCase()}`).join(',');
  const URL = `https://coins.llama.fi/prices/current/${contractsAsString.toLowerCase()}`;

  const priceRequest = await fetch(URL);
  const data: { coins: Record<string, CoinData> } = await priceRequest.json();

  // Initialize result array with token names and zero prices
  const res: [string, number][] = contracts.map((c) => [c[0], 0]);

  // Use Object.entries() to iterate over data.coins
  Object.entries(data.coins).forEach(([key, value]) => {
    const contract_value = key.split(':')[1];
    const index = contracts.findIndex((c) => c[1].toLowerCase() === contract_value);
    if (index !== -1) {
      res[index][1] = value.price;
    }
  });

  return res;
};

/**
 * Gets the price of a token on Binance (Centralized Exchange)
 * @param symbol Token symbol
 * @returns {Promise<number>} Token price
 */
export const getTokenPrice = async (symbol: string = 'ETH'): Promise<number> => {
  const URL = `https://api.binance.us/api/v3/ticker/price?symbol=${symbol}USDT`;

  const priceRequest = await fetch(URL);
  const data: { price: string } = await priceRequest.json();

  return parseFloat(data.price);
};
