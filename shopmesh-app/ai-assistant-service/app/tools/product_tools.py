import json
import logging
from typing import Any, Dict

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


async def search_products(tool_input: Dict[str, Any]) -> str:
    params = {}
    if tool_input.get("query"):
        params["search"] = tool_input["query"]
    if tool_input.get("category"):
        params["category"] = tool_input["category"]
    if tool_input.get("min_price") is not None:
        params["minPrice"] = tool_input["min_price"]
    if tool_input.get("max_price") is not None:
        params["maxPrice"] = tool_input["max_price"]

    limit = tool_input.get("limit", 10)
    params["limit"] = min(max(1, int(limit)), 20)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.product_service_url}/api/products/",
                params=params
            )
        response.raise_for_status()
        data = response.json()
        products = data.get("products", [])

        condensed = [
            {
                "productId": p.get("productId"),
                "name": p.get("name"),
                "description": (p.get("description") or "")[:200],
                "price": p.get("price"),
                "originalPrice": p.get("originalPrice"),
                "category": p.get("category"),
                "stock": p.get("stock"),
                "rating": p.get("rating"),
                "reviewCount": p.get("reviewCount"),
            }
            for p in products
        ]

        return json.dumps({
            "products": condensed,
            "total_found": len(condensed),
            "pagination": data.get("pagination", {})
        })
    except httpx.HTTPStatusError as e:
        logger.error(f"search_products HTTP error: {e.response.status_code}")
        return json.dumps({"error": f"Product service returned {e.response.status_code}", "products": []})
    except Exception as e:
        logger.error(f"search_products error: {e}")
        return json.dumps({"error": str(e), "products": []})


async def get_product_details(tool_input: Dict[str, Any]) -> str:
    product_id = tool_input.get("product_id", "")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.product_service_url}/api/products/{product_id}"
            )
        if response.status_code == 404:
            return json.dumps({"error": f"Product '{product_id}' not found"})
        response.raise_for_status()
        return json.dumps(response.json().get("product", {}))
    except httpx.HTTPStatusError as e:
        logger.error(f"get_product_details HTTP error: {e.response.status_code}")
        return json.dumps({"error": f"Product service returned {e.response.status_code}"})
    except Exception as e:
        logger.error(f"get_product_details error: {e}")
        return json.dumps({"error": str(e)})
