from fastapi import APIRouter, HTTPException, Query
from app.services.balance_service import get_balance, get_balance_all_networks
from app.services.price_service import get_all_prices, get_fiat_prices
from app.core.constants import SUPPORTED_NETWORKS
from typing import Dict, Any

router = APIRouter()

@router.get("/balance/{addr}", response_model=Dict[str, Any])
async def get_address_balance(
    addr: str,
    network: str = Query(..., description="Network name or 'all'")
):
    """
    Obtiene el balance de una dirección en una red específica o en todas las redes soportadas.
    
    - **addr**: Dirección Ethereum para la cual se quiere obtener el balance
    - **network**: Nombre de la red ('polygon', 'arbitrum', 'scroll') o 'all' para todas las redes
    """
    try:
        if network == "all":
            return await get_balance_all_networks(addr)
        elif network in SUPPORTED_NETWORKS:
            return await get_balance(addr, network)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported network: {network}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/prices", response_model=Dict[str, Dict[str, float]])
async def get_prices():
    """
    Obtiene los precios actuales de los tokens en todas las redes soportadas.
    """
    return await get_all_prices()

@router.get("/fiat-prices", response_model=Dict[str, float])
async def get_fiat_prices_endpoint():
    """
    Obtiene los precios actuales de USD en ARS.
    """
    return await get_fiat_prices()

@router.get("/networks", response_model=Dict[str, Dict[str, Any]])
async def get_networks():
    """
    Obtiene información sobre las redes soportadas, incluyendo logos, chain IDs, y tokens.
    """
    return {
        network: {
            "logo": info["logo"],
            "chainId": info["chain_id"],
            "explorer": info["explorer"],
            "tokens": {token: {"address": token_info["address"], "decimals": token_info["decimals"]} 
                       for token, token_info in info["tokens"].items()}
        }
        for network, info in SUPPORTED_NETWORKS.items()
    }