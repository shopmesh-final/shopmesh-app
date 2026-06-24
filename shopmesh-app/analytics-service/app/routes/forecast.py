import json
import logging
from datetime import datetime, timedelta, timezone

from boto3.dynamodb.conditions import Attr
from fastapi import APIRouter, Depends

from app.db.dynamodb import get_bedrock_client, orders_table, products_table
from app.dependencies import require_admin
from app.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


def _call_bedrock(prompt: str):
    client = get_bedrock_client()
    if not client:
        logger.warning("[BEDROCK-FORECAST] bedrock_client is None — skipping (LOCAL_MODE?)")
        return None
    try:
        logger.info(f"[BEDROCK-FORECAST] Invoking {settings.bedrock_model_id} ...")
        body = json.dumps({
            "messages": [{"role": "user", "content": [{"text": prompt}]}],
            "inferenceConfig": {"max_new_tokens": 300, "temperature": 0.3}
        })
        response = client.invoke_model(
            modelId=settings.bedrock_model_id,
            body=body,
            contentType="application/json"
        )
        result = json.loads(response["body"].read())
        text = result["output"]["message"]["content"][0]["text"]
        logger.info(f"[BEDROCK-FORECAST] Success — {len(text)} chars returned")
        return text
    except Exception as e:
        logger.error(f"[BEDROCK-FORECAST] FAILED — {type(e).__name__}: {e}", exc_info=True)
        return None


def _risk_narrative(products_analysis):
    critical = [p for p in products_analysis if p["risk_level"] == "CRITICAL"]
    high = [p for p in products_analysis if p["risk_level"] == "HIGH"]
    medium = [p for p in products_analysis if p["risk_level"] == "MEDIUM"]
    trending = [p for p in products_analysis if p["trend_pct"] > 30]

    parts = []
    if critical:
        parts.append(f"CRITICAL: {', '.join(p['name'] for p in critical[:2])} will stock out within 7 days — reorder immediately.")
    if high:
        parts.append(f"High priority: {', '.join(p['name'] for p in high[:2])} need restocking within 2 weeks.")
    if not critical and not high and medium:
        parts.append(f"Moderate attention needed for {', '.join(p['name'] for p in medium[:2])} within 30 days.")
    if not critical and not high and not medium:
        parts.append("Inventory is healthy. No products are at critical or high risk of stockout.")
    if trending:
        parts.append(f"Sales trending up strongly for {trending[0]['name']} (+{trending[0]['trend_pct']}% vs 4 weeks ago).")
    if not products_analysis:
        return "No order data found for the last 28 days. Place orders to generate inventory forecasts."
    return " ".join(parts)


@router.get("/inventory-forecast")
async def inventory_forecast(current_user: dict = Depends(require_admin)):
    now = datetime.now(timezone.utc)
    four_weeks_ago = (now - timedelta(days=28)).isoformat()

    # Scan orders from the last 28 days
    resp = orders_table.scan(FilterExpression=Attr("created_at").gte(four_weeks_ago))
    orders = resp.get("Items", [])
    while "LastEvaluatedKey" in resp:
        resp = orders_table.scan(
            FilterExpression=Attr("created_at").gte(four_weeks_ago),
            ExclusiveStartKey=resp["LastEvaluatedKey"]
        )
        orders.extend(resp.get("Items", []))

    # Aggregate weekly sales per product [w1_oldest ... w4_newest]
    product_names = {}
    weekly_sales = {}

    for order in orders:
        try:
            order_date = datetime.fromisoformat(order["created_at"].replace("Z", "+00:00"))
        except Exception:
            continue
        days_ago = (now - order_date).days
        week_index = min(days_ago // 7, 3)

        for item in order.get("items", []):
            pid = item.get("product_id")
            qty = int(item.get("quantity", 0))
            if not pid:
                continue
            if pid not in weekly_sales:
                weekly_sales[pid] = [0, 0, 0, 0]
                product_names[pid] = item.get("product_name", "Unknown")
            weekly_sales[pid][3 - week_index] += qty

    # Get current stock for all products
    stock_resp = products_table.scan(
        FilterExpression=Attr("isActive").eq(True),
        ProjectionExpression="productId, #n, stock",
        ExpressionAttributeNames={"#n": "name"}
    )
    stock_map = {
        p["productId"]: {"name": p.get("name", "Unknown"), "stock": int(p.get("stock", 0))}
        for p in stock_resp.get("Items", [])
    }

    # Build per-product analysis
    risk_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    products_analysis = []

    for pid, weekly in weekly_sales.items():
        info = stock_map.get(pid, {"name": product_names.get(pid, "Unknown"), "stock": 0})
        current_stock = info["stock"]
        total_sold = sum(weekly)
        avg_weekly = round(total_sold / 4, 1)

        trend_pct = 0
        if weekly[0] > 0:
            trend_pct = round(((weekly[3] - weekly[0]) / weekly[0]) * 100)

        days_until_stockout = None
        if avg_weekly > 0:
            days_until_stockout = round(current_stock / (avg_weekly / 7))

        if days_until_stockout is None:
            risk_level = "LOW"
        elif days_until_stockout <= 7:
            risk_level = "CRITICAL"
        elif days_until_stockout <= 14:
            risk_level = "HIGH"
        elif days_until_stockout <= 30:
            risk_level = "MEDIUM"
        else:
            risk_level = "LOW"

        products_analysis.append({
            "product_id": pid,
            "name": info["name"],
            "current_stock": current_stock,
            "weekly_sales": weekly,
            "avg_weekly_sales": avg_weekly,
            "trend_pct": trend_pct,
            "days_until_stockout": days_until_stockout,
            "risk_level": risk_level,
        })

    products_analysis.sort(
        key=lambda x: (risk_order.get(x["risk_level"], 4), x.get("days_until_stockout") or 9999)
    )

    # AI narrative
    ai_narrative = None
    if not settings.local_mode and products_analysis:
        lines = [
            f"- {p['name']}: stock={p['current_stock']}, avg_weekly={p['avg_weekly_sales']}, "
            f"trend={p['trend_pct']:+d}%, days_until_stockout={p['days_until_stockout']}, risk={p['risk_level']}"
            for p in products_analysis[:10]
        ]
        prompt = (
            "You are an inventory analyst for ShopMesh e-commerce.\n"
            "Analyze this data and respond in under 120 words covering:\n"
            "1. Overall inventory health\n"
            "2. Most urgent products (name them)\n"
            "3. One key trend\n"
            "4. Recommended immediate action\n\n"
            f"Data:\n{chr(10).join(lines)}"
        )
        ai_narrative = _call_bedrock(prompt)

    if not ai_narrative:
        ai_narrative = _risk_narrative(products_analysis)

    return {
        "generated_at": now.isoformat(),
        "total_orders_analyzed": len(orders),
        "ai_narrative": ai_narrative,
        "products": products_analysis,
    }
