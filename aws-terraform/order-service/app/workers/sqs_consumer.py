"""
SQS Consumer Worker — processes order events from the shopmesh-order-processing queue.

This module runs as a background thread started by the FastAPI lifespan handler.
It polls SQS, processes each message, and handles retries + DLQ via SQS's
built-in visibility timeout and maxReceiveCount configuration.
"""

import json
import logging
import threading
import time
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.config import settings
from app.repositories import order_repository
from app.services import sns_service

logger = logging.getLogger(__name__)

_stop_event = threading.Event()
_worker_thread: Optional[threading.Thread] = None


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


def _process_message(message: dict) -> bool:
    """
    Process a single SQS message.
    Returns True if processed successfully (message should be deleted).
    Returns False if processing failed (message will become visible again for retry).
    """
    body = json.loads(message["Body"])
    event_type = body.get("event", "unknown")
    order_id = body.get("order_id")

    logger.info(f"[SQS-CONSUMER] Processing event={event_type} order_id={order_id}")

    if event_type == "order.created":
        # Transition order from pending → confirmed
        order = order_repository.get_order_by_id(order_id)
        if not order:
            logger.warning(f"[SQS-CONSUMER] Order not found: {order_id}")
            return True  # Ack — nothing to retry

        if order.get("status") != "pending":
            logger.info(f"[SQS-CONSUMER] Order {order_id} already processed (status={order['status']})")
            return True

        updated = order_repository.update_order_status(order_id, "confirmed")
        if updated:
            logger.info(f"[SQS-CONSUMER] Order {order_id} confirmed")
            sns_service.notify_order_status_changed(
                order_id=order_id,
                new_status="confirmed",
                user_email=order.get("user_email", ""),
            )
        return True

    else:
        logger.warning(f"[SQS-CONSUMER] Unknown event type: {event_type}")
        return True  # Ack unknown events to avoid infinite retry


def _poll_loop():
    """Main polling loop — runs in a background daemon thread."""
    queue_url = settings.sqs_order_queue_url

    if not queue_url:
        logger.info("[SQS-CONSUMER] No SQS_ORDER_QUEUE_URL configured — consumer not running")
        return

    if settings.local_mode and settings.sqs_endpoint:
        logger.info(f"[SQS-CONSUMER] Starting in LOCAL_MODE against {settings.sqs_endpoint}")
    elif settings.local_mode:
        logger.info("[SQS-CONSUMER] LOCAL_MODE=true but no SQS endpoint — consumer not running")
        return
    else:
        logger.info(f"[SQS-CONSUMER] Starting SQS consumer on queue: {queue_url}")

    client = _get_sqs_client()

    while not _stop_event.is_set():
        try:
            response = client.receive_message(
                QueueUrl=queue_url,
                MaxNumberOfMessages=10,
                WaitTimeSeconds=20,           # Long polling
                VisibilityTimeout=30,          # 30s to process each message
                MessageAttributeNames=["All"],
            )

            messages = response.get("Messages", [])
            if not messages:
                continue

            for msg in messages:
                receipt_handle = msg["ReceiptHandle"]
                try:
                    success = _process_message(msg)
                    if success:
                        # Delete from queue
                        client.delete_message(
                            QueueUrl=queue_url,
                            ReceiptHandle=receipt_handle,
                        )
                        logger.debug(f"[SQS-CONSUMER] Message deleted: {msg['MessageId']}")
                    else:
                        # Leave message in queue — visibility timeout will expire
                        logger.warning(
                            f"[SQS-CONSUMER] Processing failed for message {msg['MessageId']} — will retry"
                        )
                        # Notify failure after re-read (handled by DLQ if maxReceiveCount exceeded)
                        sns_service.notify_order_failure(
                            order_id=json.loads(msg["Body"]).get("order_id", "unknown"),
                            reason="Processing failed — scheduled for retry",
                        )
                except Exception as e:
                    logger.error(f"[SQS-CONSUMER] Unhandled error processing message: {e}")

        except ClientError as e:
            error_code = e.response["Error"]["Code"]
            if error_code == "AWS.SimpleQueueService.NonExistentQueue":
                logger.error(f"[SQS-CONSUMER] Queue not found: {queue_url} — stopping consumer")
                break
            logger.error(f"[SQS-CONSUMER] SQS client error: {e} — retrying in 5s")
            time.sleep(5)
        except Exception as e:
            logger.error(f"[SQS-CONSUMER] Unexpected error: {e} — retrying in 5s")
            time.sleep(5)

    logger.info("[SQS-CONSUMER] Worker stopped")


def start_consumer():
    """Start the SQS consumer in a background daemon thread."""
    global _worker_thread, _stop_event
    _stop_event.clear()
    _worker_thread = threading.Thread(target=_poll_loop, daemon=True, name="sqs-consumer")
    _worker_thread.start()
    logger.info("[SQS-CONSUMER] Background worker thread started")


def stop_consumer():
    """Signal the SQS consumer to stop gracefully."""
    global _stop_event
    _stop_event.set()
    if _worker_thread and _worker_thread.is_alive():
        _worker_thread.join(timeout=5)
    logger.info("[SQS-CONSUMER] Background worker stopped")
