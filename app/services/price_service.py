"""
Este módulo proporciona servicios para obtener precios de tokens y tipos de cambio fiat.
"""

import aiohttp
from typing import List, Dict
from cachetools import TTLCache

from app.core.constants import SUPPORTED_NETWORKS

# Caché para precios con TTL de 10 minutos
price_cache = TTLCache(maxsize=100, ttl=600)
# Caché para precios fiat con TTL de 1 hora
fiat_price_cache = TTLCache(maxsize=1, ttl=3600)

async def get_prices(network: str, tokens: List[str]) -> Dict[str, float]:
    """
    Obtiene los precios actuales de los tokens especificados en una red.

    Args:
        network (str): El nombre de la red blockchain.
        tokens (List[str]): Lista de símbolos de tokens.

    Returns:
        Dict[str, float]: Un diccionario con los precios de los tokens.
    """
    cache_key = f"{network}:{','.join(sorted(tokens))}"
    cached_result = price_cache.get(cache_key)
    if cached_result:
        return cached_result

    contract_addresses = [SUPPORTED_NETWORKS[network]['tokens'][token]['address'] for token in tokens if token != 'native']
    contract_addresses.append("0x0000000000000000000000000000000000000000")  # Dirección para moneda nativa
    
    contracts_string = ",".join(f"{network}:{addr.lower()}" for addr in contract_addresses)
    url = f"https://coins.llama.fi/prices/current/{contracts_string.lower()}"

    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            data = await response.json()

    prices = {}
    for token in tokens:
        if token != 'native':
            contract_address = SUPPORTED_NETWORKS[network]['tokens'][token]['address'].lower()
        else:
            contract_address = "0x0000000000000000000000000000000000000000"
        prices[token] = data['coins'].get(f"{network}:{contract_address}", {}).get('price', 0)

    price_cache[cache_key] = prices
    return prices

async def get_all_prices() -> Dict[str, Dict[str, float]]:
    """
    Obtiene los precios de todos los tokens en todas las redes soportadas.

    Returns:
        Dict[str, Dict[str, float]]: Un diccionario con los precios de todos los tokens en todas las redes.
    """
    all_prices = {}
    for network in SUPPORTED_NETWORKS:
        tokens = list(SUPPORTED_NETWORKS[network]['tokens'].keys())
        all_prices[network] = await get_prices(network, tokens)
    return all_prices

async def get_fiat_prices() -> Dict[str, float]:
    """
    Obtiene los tipos de cambio fiat actuales.

    Returns:
        Dict[str, float]: Un diccionario con los tipos de cambio fiat.
    """
    cached_result = fiat_price_cache.get('fiat_prices')
    if cached_result:
        return cached_result

    url = "https://criptoya.com/api/binance/usdt/ars"
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            data = await response.json()

    fiat_prices = {
        'USD_ARS': data['totalAsk']
    }
    fiat_price_cache['fiat_prices'] = fiat_prices
    return fiat_prices