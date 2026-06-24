import logging
from typing import Optional

import httpx
from fastapi import Header, HTTPException, Request, status

from app.config import settings

logger = logging.getLogger(__name__)


async def get_current_user(
    request: Request,
    authorization: Optional[str] = Header(None)
):
    """Validate JWT token with Auth Service and return user info."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization token required"
        )

    token = authorization.split(" ")[1]

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{settings.auth_service_url}/api/auth/validate",
                json={"token": token}
            )

        if response.status_code == 200:
            data = response.json()
            if data.get("valid"):
                return data["user"]

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token"
        )
    except httpx.TimeoutException:
        logger.error("Auth service timeout")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service timeout"
        )
    except httpx.ConnectError:
        logger.error("Auth service connection failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Auth validation error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal authentication error"
        )


async def get_product_details(product_id: str) -> dict:
    """Fetch product details from Product Service."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                f"{settings.product_service_url}/api/products/{product_id}"
            )

        if response.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Product {product_id} not found"
            )

        if response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Failed to fetch product details"
            )

        return response.json()["product"]
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Product service timeout"
        )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Product service unavailable"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Product fetch error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal product fetch error"
        )


async def decrement_product_stock(product_id: str, quantity: int, authorization: str) -> dict:
    """Atomically decrement stock via Product Service. Raises 409 if insufficient."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.patch(
                f"{settings.product_service_url}/api/products/{product_id}/decrement-stock",
                json={"quantity": quantity},
                headers={"Authorization": authorization},
            )
        if response.status_code == 409:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Insufficient stock available")
        if response.status_code != 200:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Failed to update product stock")
        return response.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Product service timeout during stock update")
    except httpx.ConnectError:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Product service unavailable")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stock decrement error for {product_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal stock update error")


async def restore_product_stock(product_id: str, quantity: int, authorization: str) -> None:
    """Restore stock via Product Service (used for rollback on order creation failure)."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.patch(
                f"{settings.product_service_url}/api/products/{product_id}/restore-stock",
                json={"quantity": quantity},
                headers={"Authorization": authorization},
            )
    except Exception as e:
        logger.error(f"Stock restore error for {product_id}: {e}")
