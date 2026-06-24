import logging
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routes import forecast, demographics

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [ANALYTICS-SERVICE] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="ShopMesh Analytics Service",
    description="Inventory forecasting and demographic analytics powered by Amazon Bedrock",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(forecast.router, prefix="/api/analytics", tags=["analytics"])
app.include_router(demographics.router, prefix="/api/analytics", tags=["analytics"])


@app.get("/health")
def health_check():
    return {
        "status": "OK",
        "service": "analytics-service",
        "local_mode": settings.local_mode,
        "bedrock_enabled": not settings.local_mode,
    }
