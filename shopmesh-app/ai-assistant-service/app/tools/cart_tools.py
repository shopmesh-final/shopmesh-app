import json
import logging
from typing import Any, Dict, List

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


async def add_to_cart(tool_input: Dict[str, Any]) -> str:
    """
    Verifies the product exists and has sufficient stock, then returns a cart_action.
    The frontend ChatWidget applies this action to CartContext.
    """
    product_id = tool_input.get("product_id", "")
    quantity = max(1, int(tool_input.get("quantity", 1)))

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.product_service_url}/api/products/{product_id}"
            )
        if response.status_code == 404:
            return json.dumps({"error": f"Product '{product_id}' not found.", "cart_action": None})
        response.raise_for_status()
        product = response.json().get("product", {})

        if not product.get("isActive", True):
            return json.dumps({"error": "This product is no longer available.", "cart_action": None})

        available_stock = product.get("stock", 0)
        if available_stock < quantity:
            return json.dumps({
                "error": f"Insufficient stock. Only {available_stock} unit(s) available.",
                "cart_action": None
            })

        cart_action = {
            "type": "ADD_TO_CART",
            "product": {
                "productId": product.get("productId"),
                "_id": product.get("productId"),
                "name": product.get("name"),
                "price": product.get("price"),
                "stock": available_stock,
                "imageUrl": product.get("imageUrl"),
                "category": product.get("category"),
                "quantity": quantity,
            }
        }
        return json.dumps({
            "success": True,
            "message": f"Added {quantity}x {product.get('name')} to cart at ${product.get('price'):.2f} each.",
            "cart_action": cart_action
        })
    except httpx.HTTPStatusError as e:
        logger.error(f"add_to_cart HTTP error: {e.response.status_code}")
        return json.dumps({"error": f"Could not verify product (status {e.response.status_code}).", "cart_action": None})
    except Exception as e:
        logger.error(f"add_to_cart error: {e}")
        return json.dumps({"error": str(e), "cart_action": None})


async def remove_from_cart(tool_input: Dict[str, Any]) -> str:
    product_id = tool_input.get("product_id", "")
    return json.dumps({
        "success": True,
        "message": f"Removed item from cart.",
        "cart_action": {"type": "REMOVE_FROM_CART", "product_id": product_id}
    })


async def clear_cart(tool_input: Dict[str, Any]) -> str:
    return json.dumps({
        "success": True,
        "message": "Cart cleared.",
        "cart_action": {"type": "CLEAR_CART"}
    })


async def place_order(
    tool_input: Dict[str, Any],
    token: str,
    cart_items: List[Dict[str, Any]]
) -> str:
    """
    Places an order using cart_items from the frontend request body.
    cart_items shape: [{product_id, name, price, quantity}]
    """
    shipping_address = tool_input.get("shipping_address", "").strip()
    if len(shipping_address) < 5:
        return json.dumps({"error": "Shipping address must be at least 5 characters."})
    if not cart_items:
        return json.dumps({"error": "Cart is empty. Please add items before placing an order."})

    order_payload = {
        "items": [
            {"product_id": item.get("product_id"), "quantity": item.get("quantity", 1)}
            for item in cart_items
        ],
        "shipping_address": shipping_address,
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                f"{settings.order_service_url}/api/orders/",
                json=order_payload,
                headers={"Authorization": f"Bearer {token}"}
            )
        if response.status_code in (200, 201):
            order = response.json()
            return json.dumps({
                "success": True,
                "order_id": order.get("order_id"),
                "total_amount": order.get("total_amount"),
                "status": order.get("status"),
                "message": f"Order placed successfully! Order ID: {order.get('order_id')}",
                "cart_action": {"type": "ORDER_PLACED", "order_id": order.get("order_id")}
            })
        else:
            detail = response.json().get("detail") or response.json().get("message", "Order failed")
            return json.dumps({"error": str(detail)})
    except httpx.HTTPStatusError as e:
        logger.error(f"place_order HTTP error: {e.response.status_code}")
        try:
            detail = e.response.json().get("detail", f"Order service error {e.response.status_code}")
        except Exception:
            detail = f"Order service error {e.response.status_code}"
        return json.dumps({"error": str(detail)})
    except Exception as e:
        logger.error(f"place_order error: {e}")
        return json.dumps({"error": str(e)})
