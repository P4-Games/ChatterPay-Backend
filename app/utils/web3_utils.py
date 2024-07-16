"""
Este módulo proporciona utilidades para interactuar con redes blockchain usando Web3.
"""

from web3 import Web3
from app.core.constants import SUPPORTED_NETWORKS
from app.core.config import settings

def get_web3(network: str) -> Web3:
    """
    Crea y retorna una instancia de Web3 para la red especificada.

    Args:
        network (str): El nombre de la red blockchain.

    Returns:
        Web3: Una instancia de Web3 configurada para la red especificada.

    Raises:
        KeyError: Si la red especificada no está soportada.
    """
    if network not in SUPPORTED_NETWORKS:
        raise KeyError(f"Unsupported network: {network}")

    rpc_url = SUPPORTED_NETWORKS[network]['rpc'].format(ALCHEMY_API_KEY=settings.ALCHEMY_API_KEY)
    return Web3(Web3.HTTPProvider(rpc_url))