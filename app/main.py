from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from app.api.routes import router as api_router
from app.core.config import settings

app = FastAPI(
    title="Multi-Chain Balance API",
    description="API para obtener balances y precios en múltiples redes blockchain",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

app.include_router(api_router, prefix="/api")

@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/docs")

@app.exception_handler(404)
async def custom_404_handler(request: Request, exc: Exception):
    return RedirectResponse(url="/docs")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)