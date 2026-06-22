import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routes import orders
from app.workers import sqs_consumer

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [ORDER-SERVICE] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handle startup and shutdown events."""
    logger.info("Order service starting up...")
    logger.info(f"LOCAL_MODE={settings.local_mode}, Region={settings.aws_region}")
    logger.info(f"DynamoDB Table={settings.dynamodb_orders_table}")

    # Verify DynamoDB connectivity
    try:
        from app.db.dynamodb import get_dynamodb_client
        client = get_dynamodb_client()
        client.list_tables(Limit=1)
        logger.info("DynamoDB connection verified")
    except Exception as e:
        logger.error(f"DynamoDB connectivity check failed: {e}")
        logger.warning("Continuing startup despite DynamoDB check failure — table may not exist yet")

    # Start SQS consumer background thread
    sqs_consumer.start_consumer()

    yield

    # Shutdown
    logger.info("Order service shutting down...")
    sqs_consumer.stop_consumer()


app = FastAPI(
    title="Order Service",
    description="E-Commerce Order Management Microservice — AWS DynamoDB + SQS + SNS",
    version="2.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(orders.router, prefix="/api/orders", tags=["orders"])


@app.get("/health")
async def health_check():
    return {
        "status": "OK",
        "service": "order-service",
        "local_mode": settings.local_mode,
        "region": settings.aws_region,
    }
