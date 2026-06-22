import boto3
from app.config import settings


def _make_bedrock():
    if settings.local_mode:
        return None
    return boto3.client("bedrock-runtime", region_name=settings.aws_region)


bedrock_client = _make_bedrock()
