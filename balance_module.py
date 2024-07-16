"""
Módulo de Balance

Este módulo proporciona funciones para obtener precios de tokens y balances de cuentas en la red Polygon.
"""

import json
from web3 import Web3
import requests
from typing import List, Tuple, Dict
import os
from dotenv import load_dotenv
import logging
from decimal import Decimal

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Cargar variables de entorno
load_dotenv()

# Configuración de la red Polygon
ALCHEMY_API_KEY = os.getenv('ALCHEMY_API_KEY')
if not ALCHEMY_API_KEY:
    logger.error("ALCHEMY_API_KEY no encontrada en las variables de entorno")
    raise ValueError("ALCHEMY_API_KEY no configurada")

POLYGON_RPC = f"https://polygon-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}"
w3 = Web3(Web3.HTTPProvider(POLYGON_RPC))

# Cargar ABI del contrato ERC20
try:
    with open("erc20.json", "r") as file:
        ERC20_ABI = json.load(file)
except FileNotFoundError:
    logger.error("Archivo erc20.json no encontrado")
    raise

def get_price_by_evm_contract(contracts: List[Tuple[str, str]], network: str = "polygon") -> List[Tuple[str, float]]:
    """
    Obtiene los precios de los tokens desde la API de DeFi Llama para los contratos EVM dados.
    """
    try:
        contracts_string = ",".join(f"{network}:{contract[1].lower()}" for contract in contracts)
        url = f"https://coins.llama.fi/prices/current/{contracts_string.lower()}"

        response = requests.get(url)
        response.raise_for_status()
        data = response.json()

        res = [[contract[0], 0] for contract in contracts]

        for key, value in data['coins'].items():
            contract_value = key.split(":")[1]
            index = next(i for i, contract in enumerate(contracts) if contract[1].lower() == contract_value)
            res[index][1] = value['price']

        return res
    except requests.RequestException as e:
        logger.error(f"Error al obtener precios: {str(e)}")
        raise

def get_token_price(symbol: str) -> float:
    """
    Obtiene el precio de un token por su símbolo.
    """
    if symbol == "MATIC":
        return 1.0
    return 0.0

def get_balance(addr: str) -> Dict[str, object]:
    """
    Obtiene el balance de varios tokens e información de la cuenta para una dirección dada.
    """
    if not w3.is_address(addr):
        raise ValueError("Dirección inválida")

    res = {
        "matic": [Decimal('0'), 0],
        "weth": [Decimal('0'), 0],
        "usdc": [Decimal('0'), 0],
    }

    contracts = {
        "weth": ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", 18],
        "usdc": ["0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6],
    }

    try:
        # Obtener balances para cada contrato
        for key, (contract_address, decimals) in contracts.items():
            contract = w3.eth.contract(address=contract_address, abi=ERC20_ABI)
            balance = contract.functions.balanceOf(addr).call()
            res[key][0] = Decimal(balance) / Decimal(10**decimals)

        # Obtener precios para cada token
        contract_array = [[key, address] for key, (address, _) in contracts.items()]
        prices = get_price_by_evm_contract(contract_array)

        # Asignar precios a cada token en el resultado
        for price in prices:
            res[price[0]][1] = Decimal(str(price[1]))  # Convertir float a Decimal

        # Obtener balance y precio de MATIC
        matic_balance = w3.eth.get_balance(addr)
        res["matic"][0] = Decimal(matic_balance) / Decimal(10**18)  # 18 decimales para MATIC
        res["matic"][1] = Decimal(str(get_token_price("MATIC")))

        # Calcular valor total estimado
        estimated_value = sum(amount * price for amount, price in res.values())

        return {
            "address": addr,
            "balances": {k: [float(v[0]), float(v[1])] for k, v in res.items()},  # Convertir Decimal a float para la respuesta JSON
            "estimatedTotalValue": float(estimated_value),
        }
    except Exception as e:
        logger.error(f"Error al obtener balance para {addr}: {str(e)}", exc_info=True)
        raise