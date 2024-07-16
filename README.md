# Multi-Chain Balance API

## Descripción

Este proyecto es una API que proporciona información sobre balances de cuentas en múltiples redes blockchain, incluyendo Polygon, Arbitrum y Scroll. La API ofrece funcionalidades para obtener balances de tokens, precios actuales y valores totales en USD y ARS.

## Características

- Consulta de balances de tokens ERC20 y tokens nativos.
- Soporte para múltiples redes: Polygon, Arbitrum y Scroll.
- Obtención de precios actuales de tokens desde DeFi Llama.
- Cálculo del valor total estimado de la cuenta en USD y ARS.
- Caché implementado para mejorar el rendimiento.
- Documentación de API con Swagger UI.

## Requisitos

- Python 3.7+
- pip

## Instalación

1. Clona el repositorio:

   ```bash
   git clone https://github.com/TomasDmArg/py-wallet-balance.git
   cd py-wallet-balance
   ```

2. Crea y activa un entorno virtual:

   ```bash
   python -m venv venv
   source venv/bin/activate  # En Windows usa `venv\Scripts\activate`
   ```

3. Instala las dependencias:

   ```bash
   pip install -r requirements.txt
   ```

4. Crea un archivo `.env` en la raíz del proyecto y añade tu clave API de Alchemy:
   ```bash
   ALCHEMY_API_KEY=tu_clave_api_de_alchemy
   ```

## Uso

1. Inicia el servidor:

   ```bash
   uvicorn app.main:app --reload
   ```

2. Accede a la API:

   - Balances: `http://localhost:8000/api/balance/{dirección_ethereum}?network={red}`
   - Precios: `http://localhost:8000/api/prices`
   - Redes soportadas: `http://localhost:8000/api/networks`
   - Precios Fiat: `http://localhost:8000/api/fiat-prices`

   Donde `{dirección_ethereum}` es la dirección que deseas consultar y `{red}` puede ser "polygon", "arbitrum", "scroll" o "all".

3. Accede a la documentación Swagger UI:
   ```bash
   http://localhost:8000/docs
   ```

## Estructura del Proyecto

```bash
multi-chain-balance-api/
│
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── api/
│   │   ├── __init__.py
│   │   └── routes.py
│   ├── core/
│   │   ├── __init__.py
│   │   ├── config.py
│   │   └── constants.py
│   ├── services/
│   │   ├── __init__.py
│   │   ├── balance_service.py
│   │   └── price_service.py
│   └── utils/
│       ├── __init__.py
│       └── web3_utils.py
│
├── tests/
│   └── test_main.py
│
├── .env
├── .gitignore
├── requirements.txt
└── README.md
```

## Pruebas

Para ejecutar las pruebas:

```bash
pytest
```
