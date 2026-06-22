from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    port: int = 3005
    local_mode: bool = True
    aws_region: str = "us-east-1"

    auth_service_url: str = "http://auth-service:3001"
    product_service_url: str = "http://product-service:3002"
    order_service_url: str = "http://order-service:3003"

    bedrock_model_id: str = "amazon.nova-lite-v1:0"

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = Settings()
