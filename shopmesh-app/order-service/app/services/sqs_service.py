import json
import logging

import boto3
from botocore.config import Config

from app.config import settings

logger = logging.getLogger(__name__)


def _get_sqs_client():
    kwargs = {
        "region_name": settings.aws_region,
        "config": Config(retries={"max_attempts": 3, "mode": "standard"}),
    }

    if settings.local_mode and settings.sqs_endpoint:
        kwargs["endpoint_url"] = settings.sqs_endpoint
        kwargs["aws_access_key_id"] = "local"
        kwargs["aws_secret_access_key"] = "local"
    elif settings.aws_access_key_id:
        kwargs["aws_access_key_id"] = settings.aws_access_key_id
        kwargs["aws_secret_access_key"] = settings.aws_secret_access_key

    return boto3.client("sqs", **kwargs)


def send_order_event(order: dict) -> bool:
    """
    Send an order-created event to SQS.
    Returns True on success, False on failure (non-fatal).
    In LOCAL_MODE without a queue URL, logs the message only.
    """
    queue_url = settings.sqs_order_queue_url

    if settings.local_mode and not queue_url:
        logger.info(f"[SQS-LOCAL] Order event (no queue configured): order_id={order.get('order_id')}")
        return True

    if not queue_url:
        logger.warning("[SQS] SQS_ORDER_QUEUE_URL not set — skipping")
        return False

    try:
        client = _get_sqs_client()
        message_body = json.dumps({
            "event": "order.created",
            "order_id": order.get("order_id"),
            "user_id": order.get("user_id"),
            "user_email": order.get("user_email"),
            "total_amount": order.get("total_amount"),
            "status": order.get("status"),
            "created_at": order.get("created_at"),
            "items": order.get("items", []),
        })

        client.send_message(
            QueueUrl=queue_url,
            MessageBody=message_body,
            MessageAttributes={
                "event_type": {
                    "DataType": "String",
                    "StringValue": "order.created",
                },
                "service": {
                    "DataType": "String",
                    "StringValue": "order-service",
                },
            },
        )
        logger.info(f"[SQS] Order event sent: order_id={order.get('order_id')}")
        return True
    except Exception as e:
        logger.error(f"[SQS] Failed to send order event: {e}")
        return False
