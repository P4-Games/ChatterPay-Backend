interface CoinData {
    price: number;
    symbol: string;
    timestamp: number;
    confidence: number;
}

/**
 * Obtiene el precio de un token en una red
 * @param contracts Matriz de contratos de tokens con nombre y dirección
 * @param network Red de la que se obtendrán los precios (en formato de string en minúsculas)
 * @returns Matriz, donde cada elemento es un array con el nombre del token y su precio
 */
export const getPriceByEVMContract = async (contracts: [string, string][], network: string = "polygon"): Promise<[string, number][]> => {
    const contractsAsString = contracts.map((c) => `${network}:${c[1].toLowerCase()}`).join(",");
    const URL = `https://coins.llama.fi/prices/current/${contractsAsString.toLowerCase()}`;

    const priceRequest = await fetch(URL);
    const data: { coins: Record<string, CoinData> } = await priceRequest.json();

    // Initialize result array with token names and zero prices
    const res: [string, number][] = contracts.map((c) => [c[0], 0]);

    // Use Object.entries() to iterate over data.coins
    Object.entries(data.coins).forEach(([key, value]) => {
        const contract_value = key.split(":")[1];
        const index = contracts.findIndex((c) => c[1].toLowerCase() === contract_value);
        if (index !== -1) {
            res[index][1] = value.price;
        }
    });

    return res;
}

/**
 * Obtiene el precio de un token en Binance (Exchange Centralizado)
 * @param symbol Símbolo del token
 * @returns {Promise<number>} Precio del token
 */
export const getTokenPrice = async (symbol: string = "ETH"): Promise<number> => {
    const URL = `https://api.binance.us/api/v3/ticker/price?symbol=${symbol}USDT`;

    const priceRequest = await fetch(URL);
    const data: { price: string } = await priceRequest.json();

    return parseFloat(data.price);
}