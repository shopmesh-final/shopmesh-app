import logging

import boto3

from app.config import settings

logger = logging.getLogger(__name__)


def _make_dynamodb():
    kwargs = {"region_name": settings.aws_region}
    if settings.local_mode:
        kwargs.update({
            "endpoint_url": settings.dynamodb_endpoint,
            "aws_access_key_id": "local",
            "aws_secret_access_key": "local",
        })
    return boto3.resource("dynamodb", **kwargs)


def get_bedrock_client():
    """
    Returns a fresh bedrock-runtime client via cross-account STS AssumeRole.
    Called per request so credentials never expire.
    Returns None in LOCAL_MODE or if STS fails.
    """
    if settings.local_mode:
        return None
    try:
        sts = boto3.client("sts", region_name=settings.aws_region)
        assumed = sts.assume_role(
            RoleArn=settings.bedrock_cross_account_role_arn,
            RoleSessionName="analytics-bedrock",
            DurationSeconds=3600,
        )
        c = assumed["Credentials"]
        return boto3.client(
            "bedrock-runtime",
            region_name=settings.aws_region,
            aws_access_key_id=c["AccessKeyId"],
            aws_secret_access_key=c["SecretAccessKey"],
            aws_session_token=c["SessionToken"],
        )
    except Exception as e:
        logger.error(
            f"[BEDROCK] STS AssumeRole failed: {type(e).__name__}: {e}", exc_info=True
        )
        return None


_dynamodb = _make_dynamodb()

orders_table = _dynamodb.Table(settings.dynamodb_orders_table)
users_table = _dynamodb.Table(settings.dynamodb_users_table)
products_table = _dynamodb.Table(settings.dynamodb_products_table)
