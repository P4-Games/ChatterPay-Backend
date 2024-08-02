/**
 * Obtiene el precio de un token en una red
 * @param contract Matriz de contratos de tokens con nombre y dirección
 * @param network Red de la que se obtendrán los precios (en formato de string en minúsculas)
 * @returns Matriz, donde cada elemento es un array con el nombre del token y su precio
 */
export const getPriceByEVMContract = async (contract: [string, string][], network: string = "polygon")=>{
    const contractsAsString = contract.map((contract) => `${network}:${contract[1].toLowerCase()}`).join(",");
    const URL = "https://coins.llama.fi/prices/current/" + contractsAsString.toLowerCase();

    const priceRequest = await fetch(URL);
    const data = await priceRequest.json();
    
    //["<token key>", "<price>"]
    let res = contract.map((contract) => [contract[0], 0]);

    for(const key in data.coins){
        const contract_value = key.split(":")[1];
        const index = contract.findIndex((contract) => contract[1].toLowerCase() === contract_value);
        res[index][1] = data.coins[key].price;
    }

    return res;
}

/**
 * Obtiene el precio de un token en Binance (Exchange Centralizado)
 * @param symbol Símbolo del token
 * @returns {Promise<number>} Precio del token
 */
export const getTokenPrice = async (symbol: string = "ETH"): Promise<number> => {
    const URL = `https://api.binance.us/api/v3/ticker/price?symbol=${symbol}USDT`;

    let price = 0;

    const priceRequest = await fetch(URL);

    const data = await priceRequest.json();

    price = parseFloat(data.price);

    return price;
}