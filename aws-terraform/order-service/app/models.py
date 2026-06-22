from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class OrderStatus(str, Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    SHIPPED = "shipped"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


class OrderItemRequest(BaseModel):
    product_id: str = Field(..., description="DynamoDB productId (UUID)")
    quantity: int = Field(..., ge=1, le=100, description="Quantity to order")


class CreateOrderRequest(BaseModel):
    items: List[OrderItemRequest] = Field(..., min_length=1, description="List of order items")
    shipping_address: str = Field(..., min_length=5, description="Shipping address")


class OrderItem(BaseModel):
    product_id: str
    product_name: str
    product_price: float
    quantity: int
    subtotal: float


class OrderResponse(BaseModel):
    order_id: str
    user_id: str
    user_email: str
    items: List[OrderItem]
    total_amount: float
    shipping_address: str
    status: OrderStatus
    created_at: str
    updated_at: str


class UpdateOrderStatusRequest(BaseModel):
    status: OrderStatus
