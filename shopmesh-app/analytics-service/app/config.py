from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    port: int = 3004
    local_mode: bool = True
    aws_region: str = "us-east-1"

    # DynamoDB
    dynamodb_endpoint: str = "http://dynamodb-local:8000"
    dynamodb_orders_table: str = "shopmesh-orders"
    dynamodb_users_table: str = "shopmesh-users"
    dynamodb_products_table: str = "shopmesh-products"

    # Auth service for JWT validation
    auth_service_url: str = "http://auth-service:3001"

    # Bedrock
    bedrock_model_id: str = "amazon.nova-lite-v1:0"
    bedrock_cross_account_role_arn: str = "arn:aws:iam::686591366739:role/shopmesh-bedrock-cross-account"

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = Settings()
