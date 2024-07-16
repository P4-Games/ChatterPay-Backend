# Demo: Obtener Balance de una Cuenta en Polygon

Este proyecto es una demostración de cómo obtener el balance de una cuenta en la red Polygon utilizando Python. Proporciona una API simple para consultar los balances de tokens ERC20 específicos y el balance nativo de MATIC para una dirección dada.

## Características

- Consulta de balances de tokens ERC20 (WETH, USDC) y MATIC nativo.
- Obtención de precios actuales de tokens desde la API de DeFi Llama.
- Cálculo del valor total estimado de la cuenta.
- API REST simple construida con FastAPI.

## Requisitos

- Python 3.7+
- pip

## Instalación

1. Clona este repositorio:

   ```
   git clone https://github.com/TomasDmArg/py-balance-polygon.git
   cd py-balance-polygon
   ```

2. Instala las dependencias:

   ```
   pip install -r requirements.txt
   ```

3. Crea un archivo `.env` en la raíz del proyecto y añade tu clave API de Alchemy:
   ```
   ALCHEMY_API_KEY=tu_clave_api_de_alchemy
   ```

## Uso

1. Inicia el servidor:

   ```
   uvicorn main:app --reload
   ```

2. Abre tu navegador o utiliza una herramienta como curl para hacer una solicitud GET a:

   ```
   http://localhost:8000/api/address/{dirección_ethereum}
   ```

   Reemplaza `{dirección_ethereum}` con la dirección que deseas consultar.

3. La API devolverá un JSON con los balances de MATIC, WETH, USDC y el valor total estimado de la cuenta.

## Estructura del Proyecto

- `main.py`: Punto de entrada de la aplicación y configuración de FastAPI.
- `balance_module.py`: Lógica principal para obtener balances y precios.
- `erc20.json`: ABI del contrato ERC20 necesario para interactuar con los tokens.
