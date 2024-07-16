"""
Este módulo proporciona servicios para obtener balances de tokens en diferentes redes blockchain.
"""

from typing import Dict, Any
from decimal import Decimal
from web3 import Web3
import logging
from cachetools import TTLCache
import json

from app.core.constants import SUPPORTED_NETWORKS
from app.utils.web3_utils import get_web3
from app.services.price_service import get_prices, get_fiat_prices

logger = logging.getLogger(__name__)

# Caché para balances con TTL de 1 minuto
balance_cache = TTLCache(maxsize=1000, ttl=60)

# Cargar ABI del contrato ERC20
with open("app/core/erc20.json", "r") as file:
    ABI = json.load(file)

async def get_balance(addr: str, network: str) -> Dict[str, list]:
    """
    Obtiene el balance de tokens para una dirección en una red específica.

    Args:
        addr (str): La dirección Ethereum para la cual obtener el balance.
        network (str): El nombre de la red blockchain.

    Returns:
        Dict[str, list]: Un diccionario con los balances de tokens, donde cada valor es una lista [cantidad, precio].

    Raises:
        ValueError: Si la dirección es inválida.
        Exception: Para otros errores durante la obtención del balance.
    """
    cache_key = f"{network}:{addr}"
    cached_result = balance_cache.get(cache_key)
    if cached_result:
        return cached_result

    w3 = get_web3(network)
    if not w3.is_address(addr):
        raise ValueError("Invalid address")
    
    checksum_address = Web3.to_checksum_address(addr)

    res = {token: [Decimal('0'), 0] for token in SUPPORTED_NETWORKS[network]['tokens']}

    try:
        for token, info in SUPPORTED_NETWORKS[network]['tokens'].items():
            if token != 'native':
                contract = w3.eth.contract(address=info['address'], abi=ABI)
                balance = contract.functions.balanceOf(checksum_address).call()
            else:
                balance = w3.eth.get_balance(checksum_address)
            res[token][0] = Decimal(balance) / Decimal(10**info['decimals'])

        prices = await get_prices(network, list(SUPPORTED_NETWORKS[network]['tokens'].keys()))
        for token, price in prices.items():
            res[token][1] = Decimal(str(price))

        result = {k: [float(v[0]), float(v[1])] for k, v in res.items()}
        balance_cache[cache_key] = result
        return result
    except Exception as e:
        logger.error(f"Error getting balance for {addr} on {network}: {str(e)}", exc_info=True)
        raise

async def get_balance_all_networks(addr: str) -> Dict[str, Any]:
    """
    Obtiene el balance de tokens para una dirección en todas las redes soportadas.

    Args:
        addr (str): La dirección Ethereum para la cual obtener los balances.

    Returns:
        Dict[str, Any]: Un diccionario con los balances de todas las redes, valor total en USD y ARS.

    Raises:
        ValueError: Si la dirección es inválida.
    """
    if not Web3.is_address(addr):
        raise ValueError("Invalid address")
    
    checksum_address = Web3.to_checksum_address(addr)
    
    results = {}
    total_usd_value = Decimal('0')
    for network in SUPPORTED_NETWORKS.keys():
        try:
            network_balance = await get_balance(checksum_address, network)
            results[network] = network_balance
            total_usd_value += sum(Decimal(str(balance[0])) * Decimal(str(balance[1])) for balance in network_balance.values())
        except Exception as e:
            logger.error(f"Error getting balance for {addr} on {network}: {str(e)}")
            results[network] = {"error": str(e)}
    
    fiat_prices = await get_fiat_prices()
    usd_ars_rate = Decimal(str(fiat_prices['USD_ARS']))
    total_ars_value = total_usd_value * usd_ars_rate

    return {
        "address": checksum_address,
        "balances": results,
        "totalValueUSD": float(total_usd_value),
        "totalValueARS": float(total_ars_value)
    }