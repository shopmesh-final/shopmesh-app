import json
import logging
from typing import Any, Dict

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


async def get_my_orders(tool_input: Dict[str, Any], token: str) -> str:
    params = {}
    if tool_input.get("status_filter"):
        params["status_filter"] = tool_input["status_filter"]

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.order_service_url}/api/orders/",
                params=params,
                headers={"Authorization": f"Bearer {token}"}
            )
        response.raise_for_status()
        orders = response.json()
        if not isinstance(orders, list):
            orders = orders.get("orders", [])

        condensed = [
            {
                "order_id": o.get("order_id"),
                "status": o.get("status"),
                "total_amount": o.get("total_amount"),
                "shipping_address": o.get("shipping_address"),
                "created_at": o.get("created_at"),
                "items": [
                    {
                        "product_name": i.get("product_name"),
                        "quantity": i.get("quantity"),
                        "subtotal": i.get("subtotal")
                    }
                    for i in o.get("items", [])
                ]
            }
            for o in orders
        ]
        return json.dumps({"orders": condensed, "count": len(condensed)})
    except httpx.HTTPStatusError as e:
        logger.error(f"get_my_orders HTTP error: {e.response.status_code}")
        return json.dumps({"error": f"Order service returned {e.response.status_code}", "orders": []})
    except Exception as e:
        logger.error(f"get_my_orders error: {e}")
        return json.dumps({"error": str(e), "orders": []})


async def get_order_details(tool_input: Dict[str, Any], token: str) -> str:
    order_id = tool_input.get("order_id", "")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.order_service_url}/api/orders/{order_id}",
                headers={"Authorization": f"Bearer {token}"}
            )
        if response.status_code == 404:
            return json.dumps({"error": f"Order '{order_id}' not found"})
        if response.status_code == 403:
            return json.dumps({"error": "Access denied to this order"})
        response.raise_for_status()
        return json.dumps(response.json())
    except httpx.HTTPStatusError as e:
        logger.error(f"get_order_details HTTP error: {e.response.status_code}")
        return json.dumps({"error": f"Order service returned {e.response.status_code}"})
    except Exception as e:
        logger.error(f"get_order_details error: {e}")
        return json.dumps({"error": str(e)})
