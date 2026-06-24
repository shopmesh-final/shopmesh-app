import json
import logging

import boto3
from botocore.config import Config

from app.config import settings

logger = logging.getLogger(__name__)


def _get_sns_client():
    kwargs = {
        "region_name": settings.aws_region,
        "config": Config(retries={"max_attempts": 3, "mode": "standard"}),
    }

    if settings.local_mode:
        # In local mode without a local SNS endpoint, just skip
        return None

    if settings.aws_access_key_id:
        kwargs["aws_access_key_id"] = settings.aws_access_key_id
        kwargs["aws_secret_access_key"] = settings.aws_secret_access_key

    return boto3.client("sns", **kwargs)


def _publish(topic_arn: str, subject: str, message: dict) -> bool:
    """Publish a message to an SNS topic. Returns True on success."""
    if settings.local_mode:
        logger.info(f"[SNS-LOCAL] Subject: {subject} | Message: {json.dumps(message)}")
        return True

    if not topic_arn:
        logger.warning(f"[SNS] No topic ARN configured for subject: {subject}")
        return False

    client = _get_sns_client()
    if not client:
        return False

    try:
        client.publish(
            TopicArn=topic_arn,
            Subject=subject,
            Message=json.dumps(message),
            MessageAttributes={
                "service": {"DataType": "String", "StringValue": "order-service"}
            },
        )
        logger.info(f"[SNS] Published: {subject} to {topic_arn}")
        return True
    except Exception as e:
        logger.error(f"[SNS] Publish failed for {subject}: {e}")
        return False


def notify_order_created(order: dict) -> bool:
    """Publish order creation notification to shopmesh-orders topic."""
    return _publish(
        topic_arn=settings.sns_orders_topic_arn,
        subject="OrderCreated",
        message={
            "event": "order.created",
            "order_id": order.get("order_id"),
            "user_email": order.get("user_email"),
            "total_amount": order.get("total_amount"),
            "status": order.get("status"),
        },
    )


def notify_order_failure(order_id: str, reason: str) -> bool:
    """Publish failure alert to shopmesh-alerts topic."""
    return _publish(
        topic_arn=settings.sns_alerts_topic_arn,
        subject="OrderProcessingFailed",
        message={
            "event": "order.processing_failed",
            "order_id": order_id,
            "reason": reason,
        },
    )


def notify_order_status_changed(order_id: str, new_status: str, user_email: str) -> bool:
    """Publish order status change notification."""
    return _publish(
        topic_arn=settings.sns_orders_topic_arn,
        subject="OrderStatusChanged",
        message={
            "event": "order.status_changed",
            "order_id": order_id,
            "new_status": new_status,
            "user_email": user_email,
        },
    )
