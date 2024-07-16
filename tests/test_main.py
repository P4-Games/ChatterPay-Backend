import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.constants import SUPPORTED_NETWORKS

client = TestClient(app)

TEST_ADDRESS = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"

@pytest.mark.asyncio
async def test_get_networks():
    response = client.get("/api/networks")
    assert response.status_code == 200
    networks = response.json()
    assert set(networks.keys()) == set(SUPPORTED_NETWORKS.keys())
    for network, info in networks.items():
        assert "logo" in info
        assert "chainId" in info
        assert "explorer" in info
        assert "tokens" in info
        for token, token_info in info["tokens"].items():
            assert "address" in token_info
            assert "decimals" in token_info

@pytest.mark.asyncio
async def test_get_prices():
    response = client.get("/api/prices")
    assert response.status_code == 200
    prices = response.json()
    
    assert set(prices.keys()) == set(SUPPORTED_NETWORKS.keys())
    
    for network, tokens in prices.items():
        assert isinstance(tokens, dict)
        for token, price in tokens.items():
            assert isinstance(price, (int, float))
            assert price >= 0

@pytest.mark.asyncio
async def test_get_fiat_prices():
    response = client.get("/api/fiat-prices")
    assert response.status_code == 200
    fiat_prices = response.json()
    
    assert "USD_ARS" in fiat_prices
    assert isinstance(fiat_prices["USD_ARS"], (int, float))
    assert fiat_prices["USD_ARS"] > 0

@pytest.mark.asyncio
async def test_get_balance():
    test_address = TEST_ADDRESS
    for network in SUPPORTED_NETWORKS.keys():
        response = client.get(f"/api/balance/{test_address}?network={network}")
        assert response.status_code == 200
        balance = response.json()
        
        for token, [amount, price] in balance.items():
            assert isinstance(amount, (int, float))
            assert isinstance(price, (int, float))
            assert amount >= 0
            assert price >= 0

@pytest.mark.asyncio
async def test_get_balance_all_networks():
    test_address = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
    response = client.get(f"/api/balance/{test_address}?network=all")
    assert response.status_code == 200
    all_balances = response.json()
    
    assert "address" in all_balances
    assert all_balances["address"].lower() == test_address.lower()
    assert "balances" in all_balances
    assert "totalValueUSD" in all_balances
    assert "totalValueARS" in all_balances
    
    assert isinstance(all_balances["totalValueUSD"], (int, float))
    assert isinstance(all_balances["totalValueARS"], (int, float))
    assert all_balances["totalValueUSD"] >= 0
    assert all_balances["totalValueARS"] >= 0
    
    for network, balances in all_balances["balances"].items():
        for token, values in balances.items():
            assert isinstance(values, list)
            assert len(values) == 2
            amount, price = values
            assert isinstance(amount, (int, float))
            assert isinstance(price, (int, float))
            assert amount >= 0
            assert price >= 0

@pytest.mark.asyncio
async def test_invalid_network():
    test_address = TEST_ADDRESS
    response = client.get(f"/api/balance/{test_address}?network=invalid_network")
    assert response.status_code == 400
    assert "Unsupported network" in response.json()["detail"]

@pytest.mark.asyncio
async def test_invalid_address():
    response = client.get("/api/balance/0xinvalidaddress?network=polygon")
    assert response.status_code == 400
    assert "Invalid address" in response.json()["detail"]