import boto3
from botocore.config import Config

from app.config import settings


def get_dynamodb_resource():
    """Return a boto3 DynamoDB resource, configured for local or AWS."""
    kwargs = {
        "region_name": settings.aws_region,
        "config": Config(retries={"max_attempts": 3, "mode": "standard"}),
    }

    if settings.local_mode:
        kwargs["endpoint_url"] = settings.dynamodb_endpoint
        kwargs["aws_access_key_id"] = "local"
        kwargs["aws_secret_access_key"] = "local"
    elif settings.aws_access_key_id:
        kwargs["aws_access_key_id"] = settings.aws_access_key_id
        kwargs["aws_secret_access_key"] = settings.aws_secret_access_key

    return boto3.resource("dynamodb", **kwargs)


def get_dynamodb_client():
    """Return a boto3 DynamoDB low-level client."""
    kwargs = {
        "region_name": settings.aws_region,
        "config": Config(retries={"max_attempts": 3, "mode": "standard"}),
    }

    if settings.local_mode:
        kwargs["endpoint_url"] = settings.dynamodb_endpoint
        kwargs["aws_access_key_id"] = "local"
        kwargs["aws_secret_access_key"] = "local"
    elif settings.aws_access_key_id:
        kwargs["aws_access_key_id"] = settings.aws_access_key_id
        kwargs["aws_secret_access_key"] = settings.aws_secret_access_key

    return boto3.client("dynamodb", **kwargs)
