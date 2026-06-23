import boto3
from app.config import settings


def _make_bedrock():
    if settings.local_mode:
        return None
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


bedrock_client = _make_bedrock()
