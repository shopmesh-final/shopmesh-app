import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends

from app.db.dynamodb import get_bedrock_client, orders_table, users_table
from app.dependencies import require_admin
from app.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)

AGE_GROUPS = ["13-17", "18-24", "25-34", "35-44", "45-54", "55+"]
GENDERS = ["Male", "Female", "Other"]


def _age_group(age) -> str:
    if age is None:
        return "Unknown"
    age = int(age)
    if age < 18: return "13-17"
    if age < 25: return "18-24"
    if age < 35: return "25-34"
    if age < 45: return "35-44"
    if age < 55: return "45-54"
    return "55+"


def _call_bedrock(prompt: str) -> Optional[str]:
    client = get_bedrock_client()
    if not client:
        logger.warning("[BEDROCK-DEMOGRAPHICS] bedrock_client is None — skipping (LOCAL_MODE?)")
        return None
    try:
        logger.info(f"[BEDROCK-DEMOGRAPHICS] Invoking {settings.bedrock_model_id} ...")
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
        logger.info(f"[BEDROCK-DEMOGRAPHICS] Success — {len(text)} chars returned")
        return text
    except Exception as e:
        logger.error(f"[BEDROCK-DEMOGRAPHICS] FAILED — {type(e).__name__}: {e}", exc_info=True)
        return None


@router.get("/demographics")
async def demographics(current_user: dict = Depends(require_admin)):
    now = datetime.now(timezone.utc)

    # Scan all orders
    resp = orders_table.scan()
    orders = resp.get("Items", [])
    while "LastEvaluatedKey" in resp:
        resp = orders_table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"])
        orders.extend(resp.get("Items", []))

    if not orders:
        return {
            "generated_at": now.isoformat(),
            "total_orders_analyzed": 0,
            "total_users_with_demographics": 0,
            "ai_narrative": "No order data found. Place orders to generate demographic analytics.",
            "products": [],
            "summary": {"gender_totals": {}, "age_group_totals": {}},
        }

    # Batch-get user demographics (gender, age) for all unique user_ids
    unique_ids = list({o["user_id"] for o in orders if o.get("user_id")})
    user_demo = {}

    for i in range(0, len(unique_ids), 100):
        chunk = unique_ids[i:i + 100]
        try:
            batch_resp = users_table.meta.client.batch_get_item(
                RequestItems={
                    settings.dynamodb_users_table: {
                        "Keys": [{"userId": uid} for uid in chunk],
                        "ProjectionExpression": "userId, gender, age",
                    }
                }
            )
            for u in batch_resp.get("Responses", {}).get(settings.dynamodb_users_table, []):
                age = u.get("age")
                user_demo[u["userId"]] = {
                    "gender": u.get("gender", "Unknown"),
                    "age_group": _age_group(age),
                }
        except Exception as e:
            logger.error(f"Batch get users failed: {e}")

    # Aggregate per product
    product_data = {}
    for order in orders:
        uid = order.get("user_id")
        demo = user_demo.get(uid, {"gender": "Unknown", "age_group": "Unknown"})
        gender = demo["gender"]
        age_group = demo["age_group"]

        for item in order.get("items", []):
            pid = item.get("product_id")
            if not pid:
                continue
            qty = int(item.get("quantity", 0))

            if pid not in product_data:
                product_data[pid] = {
                    "product_id": pid,
                    "name": item.get("product_name", "Unknown"),
                    "total_units_sold": 0,
                    "gender_breakdown": {},
                    "age_breakdown": {},
                }

            product_data[pid]["total_units_sold"] += qty
            gd = product_data[pid]["gender_breakdown"]
            gd[gender] = gd.get(gender, 0) + qty
            ad = product_data[pid]["age_breakdown"]
            ad[age_group] = ad.get(age_group, 0) + qty

    # Convert counts to counts + percentages, sort products by total units
    products_list = []
    for pid, data in product_data.items():
        total = data["total_units_sold"]
        products_list.append({
            "product_id": pid,
            "name": data["name"],
            "total_units_sold": total,
            "gender_breakdown": {
                g: {"units": u, "pct": round((u / total) * 100) if total else 0}
                for g, u in data["gender_breakdown"].items()
            },
            "age_breakdown": {
                ag: {"units": u, "pct": round((u / total) * 100) if total else 0}
                for ag, u in data["age_breakdown"].items()
            },
        })

    products_list.sort(key=lambda x: x["total_units_sold"], reverse=True)

    # Overall totals
    total_gender: dict = {}
    total_age: dict = {}
    for p in products_list:
        for g, v in p["gender_breakdown"].items():
            total_gender[g] = total_gender.get(g, 0) + v["units"]
        for ag, v in p["age_breakdown"].items():
            total_age[ag] = total_age.get(ag, 0) + v["units"]

    # AI narrative
    ai_narrative = None
    if not settings.local_mode and products_list:
        top = products_list[:5]
        lines = []
        for p in top:
            tg = max(p["gender_breakdown"].items(), key=lambda x: x[1]["units"])[0] if p["gender_breakdown"] else "N/A"
            ta = max(p["age_breakdown"].items(), key=lambda x: x[1]["units"])[0] if p["age_breakdown"] else "N/A"
            lines.append(
                f"- {p['name']}: {p['total_units_sold']} units, "
                f"top gender={tg} ({p['gender_breakdown'].get(tg, {}).get('pct', 0)}%), "
                f"top age group={ta}"
            )
        g_summary = ", ".join(f"{g}: {u} units" for g, u in sorted(total_gender.items(), key=lambda x: -x[1]))
        a_summary = ", ".join(
            f"{ag}: {u} units"
            for ag, u in sorted(total_age.items(), key=lambda x: -x[1])
            if ag != "Unknown"
        )
        prompt = (
            "You are a retail analytics AI for ShopMesh e-commerce.\n"
            f"Overall gender totals: {g_summary}\n"
            f"Age group totals: {a_summary}\n\n"
            f"Top products:\n{chr(10).join(lines)}\n\n"
            "Provide concise insights under 120 words:\n"
            "1. Most valuable customer segment\n"
            "2. Most surprising buying pattern\n"
            "3. One targeted marketing recommendation"
        )
        ai_narrative = _call_bedrock(prompt)

    if not ai_narrative:
        if products_list:
            top = products_list[0]
            tg = max(top["gender_breakdown"].items(), key=lambda x: x[1]["units"]) if top["gender_breakdown"] else None
            ta = max(top["age_breakdown"].items(), key=lambda x: x[1]["units"]) if top["age_breakdown"] else None
            parts = [f"Top selling product is {top['name']} with {top['total_units_sold']} units sold."]
            if tg:
                parts.append(f"{tg[0]} customers are the dominant buyers ({tg[1]['pct']}%).")
            if ta and ta[0] != "Unknown":
                parts.append(f"The {ta[0]} age group leads in purchases.")
            has_unknown = any("Unknown" in p.get("age_breakdown", {}) for p in products_list[:3])
            if has_unknown:
                parts.append("Demographic data will grow as more users register with the new signup form (gender/age fields).")
            ai_narrative = " ".join(parts)
        else:
            ai_narrative = "No demographic data available yet."

    return {
        "generated_at": now.isoformat(),
        "total_orders_analyzed": len(orders),
        "total_users_with_demographics": len(user_demo),
        "ai_narrative": ai_narrative,
        "products": products_list,
        "summary": {
            "gender_totals": total_gender,
            "age_group_totals": total_age,
        },
    }
