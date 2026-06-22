import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional

import boto3
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError

from app.config import settings
from app.db.dynamodb import get_dynamodb_resource

logger = logging.getLogger(__name__)

TABLE_NAME = settings.dynamodb_orders_table


def _get_table():
    db = get_dynamodb_resource()
    return db.Table(TABLE_NAME)


def _serialize_decimals(obj):
    """Convert Decimal types from DynamoDB back to float for API responses."""
    if isinstance(obj, list):
        return [_serialize_decimals(i) for i in obj]
    if isinstance(obj, dict):
        return {k: _serialize_decimals(v) for k, v in obj.items()}
    if isinstance(obj, Decimal):
        return float(obj)
    return obj


def _floats_to_decimals(obj):
    """Convert float types to Decimal before writing to DynamoDB.
    DynamoDB's boto3 resource client does not accept Python floats.
    """
    if isinstance(obj, list):
        return [_floats_to_decimals(i) for i in obj]
    if isinstance(obj, dict):
        return {k: _floats_to_decimals(v) for k, v in obj.items()}
    if isinstance(obj, float):
        return Decimal(str(obj))
    return obj


def create_order(
    user_id: str,
    user_email: str,
    items: list,
    total_amount: float,
    shipping_address: str,
) -> dict:
    """Insert a new order into DynamoDB. Returns the created order dict."""
    table = _get_table()
    now = datetime.now(timezone.utc).isoformat()
    order_id = str(uuid.uuid4())

    item = {
        "order_id": order_id,
        "user_id": user_id,
        "user_email": user_email,
        "items": items,
        "total_amount": total_amount,
        "shipping_address": shipping_address,
        "status": "pending",
        "created_at": now,
        "updated_at": now,
    }

    # DynamoDB requires Decimal instead of float. Convert the entire item
    # (including the nested items list with product_price and subtotal).
    ddb_item = _floats_to_decimals(item)

    table.put_item(Item=ddb_item)
    logger.info(f"Order created: {order_id} for user {user_email}")
    return _serialize_decimals(ddb_item)


def get_order_by_id(order_id: str) -> Optional[dict]:
    """Fetch a single order by order_id (primary key)."""
    table = _get_table()
    response = table.get_item(Key={"order_id": order_id})
    item = response.get("Item")
    return _serialize_decimals(item) if item else None


def get_orders_by_user(user_id: str, status_filter: Optional[str] = None) -> List[dict]:
    """Fetch all orders for a user using GSI (user_id-index)."""
    table = _get_table()

    kwargs = {
        "IndexName": "user_id-index",
        "KeyConditionExpression": Key("user_id").eq(user_id),
    }

    if status_filter:
        kwargs["FilterExpression"] = Attr("status").eq(status_filter)

    response = table.query(**kwargs)
    items = response.get("Items", [])

    # Sort by created_at descending (most recent first)
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return [_serialize_decimals(i) for i in items]


def update_order_status(order_id: str, new_status: str) -> Optional[dict]:
    """Update the status of an order. Returns updated order or None if not found."""
    table = _get_table()
    now = datetime.now(timezone.utc).isoformat()

    try:
        response = table.update_item(
            Key={"order_id": order_id},
            UpdateExpression="SET #s = :status, updated_at = :updated_at",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":status": new_status,
                ":updated_at": now,
            },
            ConditionExpression=Attr("order_id").exists(),
            ReturnValues="ALL_NEW",
        )
        return _serialize_decimals(response.get("Attributes", {}))
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None
        raise
