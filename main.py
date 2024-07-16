"""
API de Balance con FastAPI

Este módulo proporciona una API para obtener balances de cuentas en la red Polygon.
"""

from fastapi import FastAPI, HTTPException
from balance_module import get_balance
import logging

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

@app.get("/api/address/{addr}")
async def get_address_balance(addr: str):
    try:
        logger.info(f"Solicitando balance para la dirección: {addr}")
        result = get_balance(addr)
        logger.info(f"Balance obtenido exitosamente para la dirección: {addr}")
        return result
    except ValueError as e:
        logger.error(f"Error de valor para la dirección {addr}: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error inesperado para la dirección {addr}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error interno del servidor: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)