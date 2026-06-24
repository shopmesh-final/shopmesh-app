import logging
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routes import chat

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [AI-ASSISTANT-SERVICE] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="ShopMesh AI Assistant Service",
    description="Conversational shopping assistant powered by Amazon Bedrock Nova Lite",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router, prefix="/api/assistant", tags=["assistant"])


@app.get("/health")
def health_check():
    return {
        "status": "OK",
        "service": "ai-assistant-service",
        "local_mode": settings.local_mode,
        "bedrock_enabled": not settings.local_mode,
        "model": settings.bedrock_model_id,
    }
