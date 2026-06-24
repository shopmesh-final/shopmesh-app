import boto3
from app.config import settings


def _make_dynamodb():
    kwargs = {"region_name": settings.aws_region}
    if settings.local_mode:
        kwargs.update({
            "endpoint_url": settings.dynamodb_endpoint,
            "aws_access_key_id": "local",
            "aws_secret_access_key": "local",
        })
    return boto3.resource("dynamodb", **kwargs)


def _make_bedrock():
    if settings.local_mode:
        return None
    return boto3.client("bedrock-runtime", region_name=settings.aws_region)


_dynamodb = _make_dynamodb()

orders_table = _dynamodb.Table(settings.dynamodb_orders_table)
users_table = _dynamodb.Table(settings.dynamodb_users_table)
products_table = _dynamodb.Table(settings.dynamodb_products_table)
bedrock_client = _make_bedrock()
