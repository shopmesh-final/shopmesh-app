import logging
from typing import Optional

import httpx
from fastapi import Header, HTTPException, status

from app.config import settings

logger = logging.getLogger(__name__)


async def require_auth(authorization: Optional[str] = Header(None)) -> dict:
    """
    Validates JWT with auth-service. Returns {user, token} so the token
    can be forwarded to downstream services (orders, auth/me).
    Any authenticated user (user or admin) is allowed.
    """
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
                return {"user": data["user"], "token": token}

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Auth validation error: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable"
        )
