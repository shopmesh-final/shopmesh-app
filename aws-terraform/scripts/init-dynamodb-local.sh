#!/bin/bash
# ─── DynamoDB Local Table Initialization Script ────────────────────────────
# Creates the 3 required DynamoDB tables in DynamoDB Local.
# Run this after starting DynamoDB Local with docker compose.

set -euo pipefail

ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
REGION="us-east-1"
AWS_OPTS="--endpoint-url $ENDPOINT --region $REGION"

echo "Initializing DynamoDB Local tables at $ENDPOINT..."

# ─── Users Table ──────────────────────────────────────────────────────────
echo "Creating shopmesh-users table..."
aws dynamodb create-table $AWS_OPTS \
  --table-name shopmesh-users \
  --attribute-definitions \
    AttributeName=userId,AttributeType=S \
    AttributeName=email,AttributeType=S \
  --key-schema AttributeName=userId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes '[{
    "IndexName":"email-index",
    "KeySchema":[{"AttributeName":"email","KeyType":"HASH"}],
    "Projection":{"ProjectionType":"ALL"}
  }]' 2>/dev/null && echo "  ✓ shopmesh-users created" || echo "  ℹ shopmesh-users already exists"

# ─── Products Table ───────────────────────────────────────────────────────
echo "Creating shopmesh-products table..."
aws dynamodb create-table $AWS_OPTS \
  --table-name shopmesh-products \
  --attribute-definitions AttributeName=productId,AttributeType=S \
  --key-schema AttributeName=productId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST 2>/dev/null && echo "  ✓ shopmesh-products created" || echo "  ℹ shopmesh-products already exists"

# ─── Orders Table ─────────────────────────────────────────────────────────
echo "Creating shopmesh-orders table..."
aws dynamodb create-table $AWS_OPTS \
  --table-name shopmesh-orders \
  --attribute-definitions \
    AttributeName=order_id,AttributeType=S \
    AttributeName=user_id,AttributeType=S \
  --key-schema AttributeName=order_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes '[{
    "IndexName":"user_id-index",
    "KeySchema":[{"AttributeName":"user_id","KeyType":"HASH"}],
    "Projection":{"ProjectionType":"ALL"}
  }]' 2>/dev/null && echo "  ✓ shopmesh-orders created" || echo "  ℹ shopmesh-orders already exists"

# ─── Verify ───────────────────────────────────────────────────────────────
echo ""
echo "Current tables:"
aws dynamodb list-tables $AWS_OPTS --query 'TableNames' --output table

echo ""
echo "DynamoDB Local initialization complete!"
