import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Service
    port: int = 3003
    node_env: str = "development"
    local_mode: bool = True

    # AWS
    aws_region: str = "us-east-1"
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""

    # DynamoDB
    dynamodb_endpoint: str = "http://dynamodb-local:8000"
    dynamodb_orders_table: str = "shopmesh-orders"

    # SQS
    sqs_order_queue_url: str = ""
    sqs_endpoint: str = ""

    # SNS
    sns_orders_topic_arn: str = ""
    sns_alerts_topic_arn: str = ""

    # Auth & Product service URLs (for inter-service calls)
    auth_service_url: str = "http://auth-service:3001"
    product_service_url: str = "http://product-service:3002"

    # JWT (LOCAL_MODE only; in AWS loaded from Secrets Manager)
    jwt_secret: str = "local-dev-jwt-secret-change-in-production"

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = Settings()
