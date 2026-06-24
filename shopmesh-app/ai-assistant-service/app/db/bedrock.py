import logging

import boto3

from app.config import settings

logger = logging.getLogger(__name__)


def get_bedrock_client():
    """
    Returns a fresh bedrock-runtime client by assuming the cross-account role.
    Called per request so credentials never expire mid-session.
    Returns None in LOCAL_MODE or if the STS call fails (caller must handle).
    """
    if settings.local_mode:
        return None
    try:
        sts = boto3.client("sts", region_name=settings.aws_region)
        assumed = sts.assume_role(
            RoleArn=settings.bedrock_cross_account_role_arn,
            RoleSessionName="ai-assistant-bedrock",
            DurationSeconds=3600,
        )
        c = assumed["Credentials"]
        return boto3.client(
            "bedrock-runtime",
            region_name=settings.bedrock_region,
            aws_access_key_id=c["AccessKeyId"],
            aws_secret_access_key=c["SecretAccessKey"],
            aws_session_token=c["SessionToken"],
        )
    except Exception as e:
        logger.error(
            f"[BEDROCK] STS AssumeRole failed: {type(e).__name__}: {e}", exc_info=True
        )
        return None
