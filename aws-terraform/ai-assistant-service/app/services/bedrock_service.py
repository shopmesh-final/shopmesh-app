import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.config import settings
from app.tools.definitions import TOOL_DEFINITIONS
from app.tools.product_tools import search_products, get_product_details
from app.tools.order_tools import get_my_orders, get_order_details
from app.tools.cart_tools import add_to_cart, remove_from_cart, clear_cart, place_order

logger = logging.getLogger(__name__)

MAX_TOOL_ITERATIONS = 10


def _build_system_prompt(user: dict, cart_items: List[Dict]) -> str:
    cart_summary = "empty"
    if cart_items:
        lines = [
            f"  - {item.get('name')} x{item.get('quantity')} @ ${item.get('price', 0):.2f}"
            for item in cart_items
        ]
        total = sum(item.get("price", 0) * item.get("quantity", 1) for item in cart_items)
        cart_summary = "\n".join(lines) + f"\n  Cart Total: ${total:.2f}"

    user_name = user.get("name", "there")
    user_gender = user.get("gender", "")
    user_age = user.get("age", "")

    demographic_parts = [p for p in [user_gender, str(user_age) if user_age else ""] if p]
    demographic = f" ({', '.join(demographic_parts)})" if demographic_parts else ""

    return f"""You are ShopMesh Assistant, a friendly and knowledgeable shopping assistant for ShopMesh e-commerce.

CURRENT USER: {user_name}{demographic}

CURRENT CART:
{cart_summary}

YOUR CAPABILITIES:
- Search and browse products using search_products and get_product_details
- View the user's order history and specific orders using get_my_orders and get_order_details
- Manage cart: add items (add_to_cart), remove items (remove_from_cart), clear all (clear_cart)
- Place orders on behalf of the user using place_order (requires shipping address)
- Retrieve user profile details with get_user_profile for personalized recommendations

BEHAVIOR GUIDELINES:
- Always use tools to get real-time data — never invent product names, prices, or order details
- Before calling add_to_cart, always call get_product_details first to confirm the product ID and stock
- Before placing an order, clearly confirm the cart contents and total with the user
- When the user says "the first one", "that product", or similar references, use the conversation history to identify which item they mean
- For personalized recommendations, consider the user's demographic info and order history
- Keep responses concise and helpful — format product lists clearly with prices and key features
- Never expose internal service URLs, error stack traces, or system implementation details to the user
- If a tool returns an error, communicate it gracefully to the user

RESPONSE FORMAT:
- Be conversational and friendly but efficient
- When listing products, include the product name, price, and 1-2 key features
- For orders, summarize status, items, and total clearly
- Always confirm cart additions and removals explicitly to reassure the user"""


def _build_messages(
    conversation_history: List[Dict[str, str]],
    current_message: str
) -> List[Dict]:
    messages = []
    for entry in conversation_history:
        role = entry.get("role", "user")
        content = entry.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": [{"text": content}]})

    messages.append({"role": "user", "content": [{"text": current_message}]})
    return messages


async def _get_user_profile(token: str) -> str:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                f"{settings.auth_service_url}/api/auth/me",
                headers={"Authorization": f"Bearer {token}"}
            )
        response.raise_for_status()
        return json.dumps(response.json().get("user", {}))
    except Exception as e:
        logger.error(f"get_user_profile error: {e}")
        return json.dumps({"error": str(e)})


async def _dispatch_tool(
    tool_name: str,
    tool_input: Dict[str, Any],
    token: str,
    cart_items: List[Dict]
) -> Tuple[str, Optional[Dict]]:
    """
    Dispatches a tool call and returns (result_json_string, cart_action_or_None).
    """
    logger.info(f"[TOOL] Dispatching: {tool_name} | input: {json.dumps(tool_input)[:200]}")

    result_str = ""

    if tool_name == "search_products":
        result_str = await search_products(tool_input)
    elif tool_name == "get_product_details":
        result_str = await get_product_details(tool_input)
    elif tool_name == "get_my_orders":
        result_str = await get_my_orders(tool_input, token)
    elif tool_name == "get_order_details":
        result_str = await get_order_details(tool_input, token)
    elif tool_name == "get_user_profile":
        result_str = await _get_user_profile(token)
    elif tool_name == "add_to_cart":
        result_str = await add_to_cart(tool_input)
    elif tool_name == "remove_from_cart":
        result_str = await remove_from_cart(tool_input)
    elif tool_name == "clear_cart":
        result_str = await clear_cart(tool_input)
    elif tool_name == "place_order":
        result_str = await place_order(tool_input, token, cart_items)
    else:
        result_str = json.dumps({"error": f"Unknown tool: {tool_name}"})

    cart_action = None
    try:
        parsed = json.loads(result_str)
        if isinstance(parsed, dict) and parsed.get("cart_action"):
            cart_action = parsed["cart_action"]
    except Exception:
        pass

    logger.info(f"[TOOL] Result for {tool_name}: {result_str[:300]}")
    return result_str, cart_action


async def run_assistant(
    bedrock_client,
    user_message: str,
    conversation_history: List[Dict[str, str]],
    cart_items: List[Dict],
    user: dict,
    token: str
) -> Dict[str, Any]:
    """
    Main entry point. Runs the Bedrock Converse API tool-use loop.
    Returns {message, cart_actions, timestamp}.
    """
    timestamp = datetime.now(timezone.utc).isoformat()

    if not bedrock_client:
        logger.warning("[BEDROCK] bedrock_client is None (LOCAL_MODE). Returning mock response.")
        return {
            "message": (
                "Hi! I'm the ShopMesh AI Assistant. I'm currently running in local development mode "
                "where Amazon Bedrock is disabled. In production, I can help you search for products, "
                "manage your cart, view orders, and place purchases using natural language. "
                "To enable full AI capabilities, set LOCAL_MODE=false and configure AWS credentials "
                "with Bedrock access."
            ),
            "cart_actions": [],
            "timestamp": timestamp
        }

    system_prompt = _build_system_prompt(user, cart_items)
    messages = _build_messages(conversation_history, user_message)
    accumulated_cart_actions: List[Dict] = []

    for iteration in range(1, MAX_TOOL_ITERATIONS + 1):
        logger.info(f"[BEDROCK] Converse API call #{iteration} | messages={len(messages)}")

        try:
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: bedrock_client.converse(
                    modelId=settings.bedrock_model_id,
                    messages=messages,
                    system=[{"text": system_prompt}],
                    toolConfig={"tools": TOOL_DEFINITIONS},
                    inferenceConfig={
                        "maxTokens": 1024,
                        "temperature": 0.7
                    }
                )
            )
        except Exception as e:
            logger.error(f"[BEDROCK] Converse API error: {type(e).__name__}: {e}", exc_info=True)
            return {
                "message": "I encountered an issue connecting to the AI service. Please try again in a moment.",
                "cart_actions": accumulated_cart_actions,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }

        stop_reason = response.get("stopReason", "")
        output_message = response.get("output", {}).get("message", {})
        content_blocks = output_message.get("content", [])

        logger.info(f"[BEDROCK] stopReason={stop_reason} | content_blocks={len(content_blocks)}")

        # Append assistant's response to messages for next iteration
        messages.append({"role": "assistant", "content": content_blocks})

        if stop_reason == "end_turn":
            text_response = "".join(
                block["text"] for block in content_blocks if "text" in block
            )
            return {
                "message": text_response.strip() or "I've completed your request.",
                "cart_actions": accumulated_cart_actions,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }

        elif stop_reason == "tool_use":
            tool_results_content = []

            for block in content_blocks:
                if "toolUse" not in block:
                    continue

                tool_use = block["toolUse"]
                tool_name = tool_use.get("name", "")
                tool_input = tool_use.get("input", {})
                tool_use_id = tool_use.get("toolUseId", "")

                result_str, cart_action = await _dispatch_tool(
                    tool_name, tool_input, token, cart_items
                )

                if cart_action:
                    accumulated_cart_actions.append(cart_action)

                tool_results_content.append({
                    "toolResult": {
                        "toolUseId": tool_use_id,
                        "content": [{"text": result_str}]
                    }
                })

            # Append all tool results as a single user message (Converse API requirement)
            messages.append({"role": "user", "content": tool_results_content})

        else:
            # max_tokens, stop_sequence, or unexpected stop
            logger.warning(f"[BEDROCK] Unexpected stopReason: {stop_reason}")
            text_response = "".join(
                block["text"] for block in content_blocks if "text" in block
            )
            return {
                "message": text_response.strip() or "I wasn't able to complete your request. Please try again.",
                "cart_actions": accumulated_cart_actions,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }

    logger.error(f"[BEDROCK] Tool-use loop exceeded {MAX_TOOL_ITERATIONS} iterations.")
    return {
        "message": "I'm having trouble completing this request. Please try rephrasing your question.",
        "cart_actions": accumulated_cart_actions,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
