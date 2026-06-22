import logging
from datetime import datetime, timezone
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.dependencies import require_auth
from app.db.bedrock import bedrock_client
from app.services.bedrock_service import run_assistant

router = APIRouter()
logger = logging.getLogger(__name__)


class CartItem(BaseModel):
    product_id: str
    name: str
    price: float
    quantity: int


class ConversationMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    conversation_history: List[ConversationMessage] = Field(default_factory=list)
    cart_items: List[CartItem] = Field(default_factory=list)


class ChatResponse(BaseModel):
    message: str
    cart_actions: List[Dict] = Field(default_factory=list)
    timestamp: str


@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    auth_context: dict = Depends(require_auth)
):
    """
    AI assistant chat endpoint. Accepts the user message, conversation history,
    and current cart state. Returns an AI response with optional cart_actions
    for the frontend to apply to CartContext.
    """
    user = auth_context["user"]
    token = auth_context["token"]

    logger.info(
        f"[CHAT] user={user.get('email')} | "
        f"history={len(request.conversation_history)} msgs | "
        f"cart={len(request.cart_items)} items"
    )

    try:
        result = await run_assistant(
            bedrock_client=bedrock_client,
            user_message=request.message,
            conversation_history=[m.model_dump() for m in request.conversation_history],
            cart_items=[item.model_dump() for item in request.cart_items],
            user=user,
            token=token
        )
        return ChatResponse(
            message=result["message"],
            cart_actions=result.get("cart_actions", []),
            timestamp=result.get("timestamp", datetime.now(timezone.utc).isoformat())
        )
    except Exception as e:
        logger.error(f"[CHAT] Unhandled error: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred. Please try again."
        )
