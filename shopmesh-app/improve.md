# ShopMesh — Complete System Architecture & Code Analysis

---

## PART 1 — FILE-BY-FILE ANALYSIS

---

### 1. `auth-service/src/index.js`

**File Purpose**
Entry point for the auth microservice. Boots an Express server, applies global middleware, registers routes, and loads secrets from AWS Secrets Manager before binding to a port.

**Code Breakdown**
- Lines 1–9: Loads `dotenv`, Express, and the AWS Secrets Manager SDK client.
- Lines 13–21: Helmet (security headers), open CORS, combined Morgan logging, and JSON body parsing are applied in order.
- Lines 23–29: A `/health` endpoint returns `{ status: "OK" }` — used by ALB health checks.
- Lines 35–41: Global error handler reads `err.status`, falling back to 500. Crucially it leaks `err.message` to the client — this can expose internal stack details.
- Lines 44–46: A 404 catch-all comes *after* the error handler, which is architecturally wrong — Express requires the error handler to be the final middleware, but 404 should come before the generic `(err, req, res, next)` handler. In this placement the 404 still works because it only fires for unmatched routes, not thrown errors, so it is a cosmetic ordering issue rather than a functional bug.
- Lines 52–85: `loadSecrets()` is the production secret bootstrap. In `LOCAL_MODE` it assigns a default JWT secret with a warning. In AWS mode, it makes two Secrets Manager calls — one for `shopmesh/jwt-secret` and one for `shopmesh/app-config` — then injects them into `process.env`. If either call fails, the process exits with code 1, which is correct fail-fast behavior.
- Lines 87–94: `start()` calls `loadSecrets()` then `app.listen()`. This ordering guarantees the JWT secret is ready before the first request is served.

**Design Patterns**
- Async startup gating pattern (load secrets before binding port) — correct.
- Express global error handler pattern.
- Environment-flag dual-mode (local vs. AWS) — useful but adds conditional complexity.

**Issues & Risks**
1. **`cors()` with no configuration** (line 18): Allows ALL origins, ALL methods, ALL headers. In production this is overly permissive. Should be restricted to the CloudFront domain.
2. **Error message leak** (line 38): `err.message` from internal exceptions can expose file paths, query details, or library internals to API clients.
3. **No request rate limiting**: No `express-rate-limit` on auth endpoints. The `/api/auth/register` and `/api/auth/login` routes are fully open to brute-force attacks.
4. **`process.env` mutation**: Injecting secrets into `process.env` at runtime is a common pattern but makes unit-testing harder and can be accidentally overwritten.
5. **No graceful shutdown handler**: `SIGTERM` is not handled; a rolling deploy would abruptly cut in-flight requests.

**Improvements**
- Add `cors({ origin: ['https://shopmesh.shop'] })`.
- Replace `err.message` with a generic `"Internal Server Error"` string in production.
- Add `express-rate-limit` middleware specifically on `/api/auth/login` and `/api/auth/register`.
- Handle `SIGTERM` with `server.close()`.

---

### 2. `auth-service/src/db/dynamodb.js`

**File Purpose**
Creates and exports a DynamoDB DocumentClient for use throughout the auth service. Centralizes connection configuration with a local/AWS mode switch.

**Code Breakdown**
- Lines 4–17: Uses `LOCAL_MODE` env flag. In local mode, points to `dynamodb-local:8000` with dummy credentials. In AWS mode, relies on the EC2 instance profile (no explicit credentials — correct IAM best practice).
- Lines 19–27: `DynamoDBDocumentClient.from()` wraps the raw client with `removeUndefinedValues: true`, which prevents DynamoDB validation errors from `undefined` attributes.
- Line 28: Table name falls back to `shopmesh-users` if the env var is unset.

**Issues & Risks**
1. **No connection pooling configuration**: The AWS SDK v3 manages keep-alive internally but there is no explicit `maxSockets` or `keepAlive` override. Under high concurrency, this could exhaust connection limits.
2. **Single client instance**: The module-level singleton is fine for Node.js's single-threaded model, but a cold-start restart would lose any pending in-flight requests without retry logic at the caller.
3. **Region hardcoded in local mode**: `region: 'us-east-1'` is hardcoded for local mode. Minor, but using `process.env.AWS_REGION` even in local mode would be more consistent.

---

### 3. `auth-service/src/middleware/auth.js`

**File Purpose**
JWT verification middleware for Express. Validates the `Authorization: Bearer <token>` header and attaches the decoded payload to `req.user`.

**Code Breakdown**
- Lines 3–6: Checks for the `Authorization` header and the `Bearer ` prefix. Returns 401 immediately if absent.
- Lines 9–19: Calls `jwt.verify()` synchronously. On `TokenExpiredError` returns a specific message. All other `JsonWebTokenError` sub-types collapse into a generic "Invalid token".

**Design Patterns**
- Standard Express middleware pattern — correct signature and `next()` usage.

**Issues & Risks**
1. **JWT algorithm not pinned**: `jwt.verify()` will accept any algorithm the token header declares by default. A malicious token using `alg: "none"` or `alg: "HS512"` (if the key is weak) could bypass verification. Should explicitly pass `{ algorithms: ['HS256'] }` as the options argument.
2. **Identical middleware duplicated across services**: The exact same `auth.js` file exists identically in `product-service/src/middleware/auth.js`. This violates DRY principle — if the JWT algorithm pinning fix is applied to one, it must be applied to both manually.
3. **No role checking here**: The middleware only verifies token validity. Role-based access control (`req.user.role`) is checked ad-hoc in individual routes, which can lead to access control bugs being missed.

**Critical Fix**
```js
const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
```

---

### 4. `auth-service/src/repositories/userRepository.js`

**File Purpose**
Data access layer for the users DynamoDB table. Implements all CRUD operations, password hashing, and a sanitize helper.

**Code Breakdown**
- `findByEmail` (lines 15–26): Queries the `email-index` GSI with `Limit: 1`. Uses `email.toLowerCase()` for normalization — consistent.
- `findById` (lines 31–39): Simple `GetCommand` on the primary key.
- `createUser` (lines 44–70): Generates UUID, bcrypt hashes the password with cost factor 12, builds the item, writes with `ConditionExpression: 'attribute_not_exists(userId)'` to prevent duplicate PKs. Returns the user without `passwordHash`.
- `verifyPassword` (lines 75–77): Delegates to `bcrypt.compare()` — timing-safe.
- `sanitizeUser` (lines 82–86): Strips `passwordHash` before returning to callers.

**Issues & Risks**
1. **Email uniqueness race condition**: `findByEmail` + `createUser` are two separate operations with no transactional guard. Two concurrent registrations with the same email could both pass the `findByEmail` check before either creates the user, resulting in duplicate email entries. DynamoDB doesn't support cross-item transactions easily for this, but a ConditionExpression on the email GSI or a separate email lock item would help.
2. **Cost factor 12 is good but blocks the event loop**: `bcrypt.genSalt(12)` and `bcrypt.hash()` are CPU-intensive. `bcryptjs` (pure JS) is significantly slower than the native `bcrypt` package. Under concurrent login attempts, this can block Node.js's event loop. Should use `bcrypt` (native bindings) or `argon2`.
3. **No input length validation before hashing**: Extremely long passwords (> 72 chars) are silently truncated by bcrypt. A very long password (e.g., 100KB) could cause a DoS via CPU exhaustion before bcrypt's 72-char limit kicks in. Should add a `password.length <= 128` guard in the route layer.
4. **`ConditionExpression` only prevents duplicate PKs, not duplicate emails**: Two users can exist with the same email if the race condition above occurs, because the condition only checks `attribute_not_exists(userId)`.

---

### 5. `auth-service/src/routes/auth.js`

**File Purpose**
Defines the four auth endpoints: `/register`, `/login`, `/me`, and `/validate`. Handles input validation, token issuance, and inter-service token validation.

**Code Breakdown**
- `/register` (lines 14–49): Validates name (2–50 chars), email (normalized), password (≥6 chars). Checks for existing user, creates the user, signs a JWT, returns token + user. The JWT payload includes `userId`, `email`, `role`.
- `/login` (lines 52–93): Validates email and password presence. Fetches user by email, verifies password, issues JWT. Uses generic "Invalid email or password" for both not-found and wrong-password cases — good security practice.
- `/me` (lines 96–107): Protected by `authMiddleware`. Fetches fresh user data from DynamoDB by `userId` from the token. Sanitizes and returns.
- `/validate` (lines 110–121): Accepts a token in the request body, verifies it, returns `{ valid: true, user: decoded }`. Used by the order-service for inter-service auth validation.

**Issues & Risks**
1. **`/validate` endpoint is unauthenticated and accepts tokens in a POST body**: Any caller who has network access to the auth service can call this endpoint. In the current architecture, the internal ALB routes `/api/auth/*` — and `/validate` is at `/api/auth/validate`, which is reachable from the frontend via the internal ALB proxy path. This means frontend users could potentially call `/validate` with any token and get the decoded payload. Should require a service-to-service API key or be placed on a non-proxied path.
2. **Minimum password length of 6 characters**: Far too weak for a production system. NIST SP 800-63B recommends a minimum of 8 characters. Should be at least 8, ideally 12.
3. **`JWT_EXPIRES_IN` is read at module load time**: Line 11 reads `process.env.JWT_EXPIRES_IN` when the module is first loaded, before `loadSecrets()` runs. This means it gets the `.env` default value (`24h`) rather than the Secrets Manager value. Should use `process.env.JWT_EXPIRES_IN || '24h'` at token-sign time.
4. **No refresh token mechanism**: JWTs expire in 24 hours with no refresh token. Users are silently logged out; there's no silent renewal path.
5. **Error logging includes the email**: Line 42 logs `[AUTH] User registered: ${email}`. In a high-compliance environment (GDPR), PII should not be logged in plaintext.

---

### 6. `product-service/src/index.js`

**File Purpose**
Entry point for the product microservice. Nearly identical to `auth-service/src/index.js` but also runs `seedProducts()` after secrets are loaded.

**Code Breakdown**
- The structure mirrors the auth service exactly.
- Lines 82–92: After loading secrets, calls `productRepo.seedProducts()`. Errors are caught and logged but don't abort startup — the service starts even if seeding fails. This is the correct approach.

**Issues & Risks**
1. **Same `cors()` open configuration** — identical risk as auth service.
2. **Seed runs on every startup on every EC2 instance**: When the backend ASG runs multiple instances (desired: 1, max: 4), each instance will call `seedProducts()` on startup. The seed function does a full table scan first to avoid re-inserting, but under a race condition (two instances starting simultaneously), both scans could return empty and both could insert duplicates — mitigated somewhat by the name-based deduplication in the seed logic, but the scan is not atomic.
3. **Missing `JWT_SECRET` only triggers a warn, not a fail**: Line 58 warns but does not exit if `JWT_SECRET` is missing in local mode. In AWS mode it does exit. This asymmetry could hide misconfiguration in local dev.

---

### 7. `product-service/src/repositories/productRepository.js`

**File Purpose**
Data access layer for the products DynamoDB table. Implements list (with filters), get, create, update, soft-delete, count, and seed operations.

**Code Breakdown**
- `listProducts` (lines 21–73): Builds a `FilterExpression` and calls `ScanCommand`. After the scan, it does in-memory search and pagination. The comment on line 19 acknowledges this is scan-based and should use a GSI in production.
- `createProduct` (lines 91–121): Generates UUID, parses floats/ints, sets `isActive: true`. Uses `ConditionExpression: 'attribute_not_exists(productId)'` to prevent duplicate product IDs.
- `updateProduct` (lines 126–138): Fetches the existing item, merges updates, and does a full `PutCommand` overwrite. This is a read-modify-write pattern without optimistic locking — concurrent updates can produce lost updates.
- `softDeleteProduct` (lines 143–150): Sets `isActive: false`. Same read-modify-write pattern.
- `seedProducts` (lines 170–224): Scans for existing active products by name, then inserts missing ones.

**Critical Issues**
1. **`ScanCommand` on every product listing**: A `Scan` reads every item in the table. At 10,000 products, this is O(n) on every GET `/api/products` request. This is the most significant scalability bottleneck in the entire backend. As the product catalog grows, response time and DynamoDB RCU consumption grow linearly.
2. **In-memory pagination after full scan**: Pagination is applied *after* retrieving all items from DynamoDB. With 50,000 items and `limit=20`, the service reads 50,000 items to return 20.
3. **Concurrent update race condition** (updateProduct): No version attribute or conditional write — parallel PUT requests can overwrite each other silently.
4. **Hardcoded Unsplash image URLs in seed data**: Production products point to `images.unsplash.com`. These external URLs may change or be unavailable.
5. **Missing GSI for category filtering**: The `listProducts` filter on `category` still requires a full scan. A GSI on `(isActive, category)` would enable efficient querying.

---

### 8. `product-service/src/routes/products.js`

**File Purpose**
Express router defining REST endpoints for product CRUD and presigned S3 URL generation.

**Code Breakdown**
- `GET /` (lines 11–19): Public. Passes query params to `listProducts`. No authentication required.
- `GET /:id` (lines 23–33): Public. Returns 404 if product not found or `isActive` is false.
- `POST /` (lines 36–68): Protected by `authMiddleware`. Validates name, description, price, category (against `VALID_CATEGORIES`), and stock. Publishes SNS event non-blocking after creation.
- `PUT /:id` (lines 71–83): Protected. No input validation on updates.
- `DELETE /:id` (lines 86–102): Protected. Soft-delete only. Publishes SNS alert.
- `POST /:id/upload-url` (lines 105–114): Protected. Generates a presigned S3 upload URL.

**Issues & Risks**
1. **`PUT /:id` has no input validation**: Any authenticated user can send `{ "isActive": false, "price": -100, "category": "invalid" }` and it will be accepted and stored.
2. **No authorization level check on write operations**: `authMiddleware` verifies the token is valid, but any authenticated user (including regular `role: "user"`) can create, update, or delete products. Only admins should be able to do product management.
3. **SNS publish failures are silently swallowed**: Lines 60 and 95 use `.catch(() => {})`, which completely suppresses SNS errors.
4. **Content-Type is not validated in upload URL route** (line 107): The client supplies `contentType` unchecked — a client could request a URL for `text/html` and upload HTML to the S3 images bucket.

---

### 9. `product-service/src/services/s3Service.js`

**File Purpose**
Generates S3 presigned URLs for product image uploads and downloads.

**Issues & Risks**
1. **Hardcoded `expiresIn: 300` (5 minutes)**: For large file uploads over slow connections, 5 minutes may be insufficient. Should be configurable.
2. **No file size restriction on the presigned URL**: The `PutObjectCommand` does not set `ContentLengthRange` conditions. A client can upload files of unlimited size.
3. **CORS for S3 bucket allows `["*"]` origins**: In `modules/s3/main.tf`, the S3 CORS allows all origins. Should be restricted to `https://shopmesh.shop`.
4. **`getDownloadPresignedUrl` is defined but never called** in any route — dead code.

---

### 10. `product-service/src/services/snsService.js`

**File Purpose**
SNS publish wrapper for product events. Publishes `ProductCreated` and `ProductDeleted` events.

**Issues & Risks**
1. **Wrong topic for product events**: Product creation events (`ProductCreated`) are published to `SNS_ORDERS_TOPIC_ARN`. This is architecturally incorrect and means the orders topic receives mixed event types that subscribers may not expect.
2. **No message deduplication**: SNS Standard topics don't deduplicate. A retry on a failed publish could send duplicate events to subscribers.

---

### 11. `order-service/app/main.py`

**File Purpose**
FastAPI application entry point. Uses the lifespan context manager to run startup and shutdown hooks, verify DynamoDB connectivity, and manage the SQS consumer thread.

**Issues & Risks**
1. **CORS wildcard** — same as auth/product services.
2. **OpenAPI docs exposed in production**: FastAPI enables `/docs` and `/redoc` by default. These should be disabled via `docs_url=None, redoc_url=None` in production to prevent API schema leakage.
3. **Single uvicorn worker**: The Dockerfile `CMD` runs `--workers 1`. If `--workers` is increased later, each worker will spin up a separate SQS consumer thread, causing duplicate message processing.

---

### 12. `order-service/app/config.py`

**File Purpose**
Pydantic `BaseSettings` configuration class for the order service. Reads from environment variables and `.env` file.

**Issues & Risks**
1. **No Secrets Manager integration**: Unlike the auth and product services, the order service has no `loadSecrets()` function. It relies entirely on environment variables, injected by the backend userdata script as a plaintext docker-compose.yml file on disk. Anyone with shell access to the EC2 instance can read these values.
2. **`jwt_secret` default value**: `"local-dev-jwt-secret-change-in-production"` — if `JWT_SECRET` is not set in production, this default will be used silently.
3. **Empty string for `aws_access_key_id` as default**: The check `elif settings.aws_access_key_id:` in `db/dynamodb.py` means: if the env var is unset, use the IAM instance profile (correct). But this check happens in every client factory function rather than once at startup.

---

### 13. `order-service/app/dependencies.py`

**File Purpose**
FastAPI dependency injection functions for getting the current user (via auth service HTTP call) and product details (via product service HTTP call).

**Critical Issues**
1. **Sequential product service calls in `create_order`**: In `orders.py` line 30, `get_product_details` is called for each item sequentially. With 5 items in an order, that's 5 sequential HTTP calls, each with up to 5-second timeout. Worst case: 25 seconds for order creation. Should use `asyncio.gather()` to fetch all product details concurrently.
2. **New `httpx.AsyncClient` created per request**: Both functions instantiate a new `httpx.AsyncClient` per call — creating and tearing down a TCP connection every time. Should use a shared client with connection pooling.
3. **No retry logic**: If the auth or product service returns a transient 500 error, the order creation fails without retry. Should add exponential backoff retries.

---

### 14. `order-service/app/repositories/order_repository.py`

**File Purpose**
DynamoDB data access layer for orders. Handles create, get-by-id, get-by-user (GSI query), and status update operations.

**Issues & Risks**
1. **`_get_table()` creates a new boto3 resource on every call**: Creates a new connection for every DynamoDB operation. In production, should create the resource once at module initialization.
2. **GSI query pagination not handled**: `get_orders_by_user` calls `table.query()` without pagination. If a user has more than 1MB of order data, only the first page is returned silently. Should use `LastEvaluatedKey` to paginate.
3. **In-memory sort after query**: Adding a sort key (`created_at`) to the `user_id-index` GSI would eliminate the in-memory sort and return results in the correct order directly from DynamoDB.

---

### 15. `order-service/app/routes/orders.py`

**File Purpose**
FastAPI router defining order lifecycle endpoints: create, list-mine, get-one, update-status.

**Issues & Risks**
1. **No stock decrement**: The service checks stock availability but never decrements stock after order creation. Two users can simultaneously order the same product whose stock is 1, both pass the check, and both orders are created — overselling.
2. **Stock check and order creation are not atomic**: The product service owns stock; the order service calls it for a check but cannot atomically reserve the stock.
3. **No order total rounding fix**: `total_amount` is accumulated as `total_amount += subtotal` (Python float arithmetic). For currency calculations, should use `Decimal` throughout.

---

### 16. `order-service/app/services/sqs_service.py` and `sns_service.py`

**File Purpose**
Thin wrappers around boto3 SQS/SNS clients.

**Critical Issue**
`aioboto3==12.3.0` is in `requirements.txt` but never used anywhere. The SNS and SQS services use synchronous `boto3`. In an async FastAPI app, synchronous I/O calls block the event loop and prevent other coroutines from running. Under load, one SQS send blocks all concurrent order creation requests. Should use `aioboto3` or `asyncio.get_event_loop().run_in_executor(None, ...)`.

---

### 17. `order-service/app/workers/sqs_consumer.py`

**File Purpose**
A long-polling SQS consumer that runs as a background daemon thread. Processes `order.created` events by transitioning orders from `pending` to `confirmed`.

**Issues & Risks**
1. **No exponential backoff on retries**: After a `ClientError`, the consumer sleeps 5 seconds flat. Should use exponential backoff with jitter.
2. **Only one consumer thread**: Processes 10 messages per poll but serially within the thread. For high order volume, a thread pool or async consumer would be needed.
3. **Hardcoded `VisibilityTimeout=30`** in the receive call should match the SQS queue's `visibility_timeout_seconds = 30` — they are not linked; if one changes the other must be manually updated.

---

### 18. `frontend/src/services/api.js`

**File Purpose**
Axios-based API client module. Provides three namespaced API objects: `authAPI`, `productAPI`, `orderAPI`.

**Issues & Risks**
1. **JWT stored in `localStorage`**: This is the most significant frontend security risk. `localStorage` is accessible by any JavaScript on the page, including injected scripts (XSS). Should use `httpOnly` cookies, which are inaccessible to JavaScript.
2. **No global Axios interceptor for 401 handling**: If a token expires mid-session, each API call will fail with 401 but the user won't be automatically logged out.
3. **No request timeout configured**: Axios requests have no timeout. A hung backend will leave the UI in a permanent loading state.
4. **PRODUCT_URL and ORDER_URL have trailing slashes** while the `get` calls append a path — could produce double slashes in some configurations.

---

### 19. `frontend/src/context/AuthContext.js`

**File Purpose**
React Context providing authentication state and actions to the component tree.

**Issues & Risks**
1. **localStorage token** — as noted in api.js, this is the primary risk.
2. **logout doesn't call any backend endpoint**: There is no server-side token revocation. Once issued, a JWT is valid until expiry.

---

### 20. `frontend/src/context/CartContext.js`

**File Purpose**
React Context managing the in-memory shopping cart state.

**Issues & Risks**
1. **Cart is not persisted**: The cart is in-memory only. Refreshing the page clears it entirely. Should use `localStorage` or `sessionStorage` for persistence.
2. **No max quantity per item**: A user can add 10,000 units of a product with stock of 1. The stock validation only happens server-side at order creation time.
3. **Float arithmetic for `totalAmount`**: `i.price * i.quantity` can produce floating-point precision issues (e.g., `$29.99 × 3 = $89.97000000000001`).

---

### 21. `frontend/src/pages/ProductsPage.js`

**File Purpose**
Main shopping page. Fetches and displays products with filtering, search, and add-to-cart functionality.

**Issues & Risks**
1. **Double filtering**: Search is done server-side AND client-side — redundant but harmless.
2. **No pagination controls**: The backend supports `page` and `limit` parameters but the frontend never sends them — always gets all products in a single call.
3. **`product._id` undefined bug** (line 86): `setAddedMap(prev => ({ ...prev, [product._id]: true }))` — `product._id` is `undefined` before `addToCart` normalizes it (products from the API use `productId`, not `_id`). The "Added" button state never fires correctly.

---

### 22. `frontend/src/pages/AuthPage.js`

**File Purpose**
Login/register combined page with tab switching.

**Issues & Risks**
1. **No CSRF protection**: Since auth tokens are in localStorage (not cookies), CSRF is not directly applicable, but the lack of SameSite cookies means there is no stateful CSRF protection at all.

---

### 23. `frontend/nginx.conf`

**File Purpose**
Nginx configuration for the frontend container. Serves the React SPA and proxies API calls to the internal ALB.

**Issues & Risks**
1. **Security headers are incomplete**: Missing `Content-Security-Policy` (CSP) and `Permissions-Policy`. The `X-XSS-Protection` header set is deprecated in modern browsers.
2. **No rate limiting at nginx level**: Nginx can enforce `limit_req_zone` for rate limiting, providing defense-in-depth against DDoS before requests hit the backend.
3. **No HTTP/2 configuration**: Nginx is serving HTTP/1.1 only.

---

### 24. Terraform Infrastructure — Module Analysis

#### `modules/vpc/main.tf`
**Well-designed:**
- Dual-AZ public/private subnet split.
- Per-AZ NAT Gateways — provides AZ-level fault tolerance.
- VPC Gateway Endpoints for DynamoDB and S3 — traffic stays within AWS network, reduces NAT Gateway costs and latency.

**Issues:**
- `map_public_ip_on_launch = true` on public subnets means frontend EC2 instances get public IPs. Since the ALB handles all inbound traffic, EC2 instances in public subnets don't need public IPs — this is a security gap.

#### `modules/security-groups/main.tf`
**Well-designed:**
- External ALB accepts only 80/443 from internet.
- Frontend EC2 accepts port 80 only from external ALB SG.
- Internal ALB accepts traffic only from frontend SG.
- Backend EC2 accepts service ports only from internal ALB SG.
- SSH explicitly removed — replaced by SSM Session Manager.

**Issues:**
1. **Backend egress is `0.0.0.0/0`**: Should be restricted to known endpoints.
2. **Inter-service `self` rule** (lines 119–123): If one service is compromised, it can call any other service directly without going through the internal ALB.

#### `modules/iam/main.tf`
**Well-designed:**
- Separate roles for frontend and backend EC2.
- Backend role has scoped policies per AWS service.
- SSM managed policy attached.
- EventBridge role with minimal SNS publish permission.

**Issues:**
1. **Backend DynamoDB policy allows all three tables**: All three services share one EC2 instance and one IAM role. A compromised auth service could enumerate all orders. True least-privilege would require per-service roles.
2. **CloudWatch `Resource: "*"`**: `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` are all on `*`. Should be scoped to `/shopmesh/*` log group ARNs.

#### `modules/dynamodb/main.tf`
**Well-designed:**
- `PAY_PER_REQUEST` billing mode.
- PITR (point-in-time recovery) enabled on all three tables.
- Server-side encryption enabled.
- GSI on `email` for users, GSI on `user_id` for orders.

**Issues:**
1. **No GSI on products for category/isActive filtering**: The `listProducts` scan is the known performance bottleneck.
2. **`user_id-index` GSI has no sort key**: Orders are sorted in-memory. Adding `created_at` as the sort key would give free ordered query results.
3. **No TTL attribute defined**: For orders, having a TTL on old cancelled orders could reduce storage costs.

#### `modules/alb/main.tf`
**Well-designed:**
- External ALB: HTTP→HTTPS redirect, HTTPS with TLS 1.3 policy.
- Internal ALB: path-based routing to three target groups.
- All ALBs have access logs going to S3.
- `ELBSecurityPolicy-TLS13-1-2-2021-06` — modern TLS policy.

**Issues:**
1. **Internal ALB is unencrypted HTTP**: Traffic between frontend nginx and backend services is unencrypted inside the VPC.
2. **No WAF attached to the external ALB**: No AWS WAF is configured for SQL injection, XSS, or rate limiting at the ALB level.

#### `modules/asg/main.tf`
**Well-designed:**
- Rolling instance refresh with `min_healthy_percentage = 50`.
- Target tracking scaling on CPU (60% threshold).
- Backend ASG has both CPU and ALB request-count scaling policies.
- Frontend in public subnets, backend in private subnets.

**Issues:**
1. **Both ASGs have `min_size = 1` and `max_size = 1` in tfvars**: No auto-scaling is active. Traffic spikes cannot be absorbed.
2. **All three backend services on one EC2 instance**: Resource contention between services. A CPU-heavy scan in product-service starves auth-service and order-service.

#### `modules/cloudfront/main.tf`
**Well-designed:**
- HTTPS only between CloudFront and origin.
- Cache disabled for `/api/*`, long cache for `/static/*`.
- Custom error pages for 403/404 → serve `index.html` for React Router.
- TLS 1.2 minimum.

**Issues:**
1. **The external ALB is exposed directly**: Nothing prevents direct access to the ALB DNS name, bypassing CloudFront. Should restrict ALB to CloudFront origin IPs via custom header check or WAF.
2. **CloudFront WAF not configured**: No `web_acl_id` on the distribution.

#### `modules/secretsmanager/main.tf`
**Critical Issue — All creation is commented out**: The actual `aws_secretsmanager_secret` and `aws_secretsmanager_secret_version` resources are commented out. Only `data` sources exist (lookups). This means:
- Terraform does **not** create the secrets — they must be created manually before `terraform apply`.
- The hardcoded placeholder value `"ShopMeshDemoJWTSecret2026!"` is in version control — even commented out, this should be removed.
- There is no automated secret rotation configured.

#### `modules/sqs/main.tf`
**Well-designed:**
- DLQ with 14-day retention and max 3 receive attempts before DLQ.
- Long polling (`receive_wait_time_seconds = 20`).
- Queue-level IAM policy restricting access to the backend IAM role.

**Issues:**
1. **Visibility timeout is 30 seconds**: Too tight for an operation that involves DynamoDB read + update + SNS publish. Should be 60–90 seconds.
2. **Main queue retention is only 1 day**: If the SQS consumer is down for more than 24 hours, order events are silently lost. Should be 4–7 days minimum.

#### `modules/cloudwatch/main.tf`
**Well-designed:**
- CPU alarms for both ASGs.
- ALB 5XX count alarm.
- Unhealthy targets alarm.
- SQS queue depth alarm (100 messages).
- DynamoDB UserErrors alarm.
- Log groups with 30-day retention.

**Issues:**
1. **CloudWatch dashboard is commented out**: In production, operators have no visual dashboard — only alarms.
2. **Unhealthy targets alarm only monitors the auth target group**: Product and order target groups are not monitored.
3. **`UserErrors` is not throttling**: The correct metric for DynamoDB throttling is `ThrottledRequests`, not `UserErrors`.

#### `modules/eventbridge/main.tf`
**Issues:**
1. **EventBridge rules publish to SNS but there are no subscribers that act on these events**: The scheduled rules fire and publish to SNS, but nothing processes them. They are essentially stubs with no functional implementation.
2. **Hourly health check via SNS email** is not a real health check — it's a scheduled notification with no actual health verification logic.

---

### 25. Userdata Scripts

**`scripts/backend-userdata.sh`**
- **Hardcoded public GitHub URL fallback** (lines 85–88): `git clone https://github.com/priyatham7753/tempo3.git` — exposes a dependency on a public GitHub repo that could be deleted, renamed, or have malicious commits pushed to it.
- **Wrong S3 bucket name** (line 132): `S3_PRODUCT_IMAGES_BUCKET=$PROJECT_NAME-product-images` — missing the account ID suffix. The actual bucket name is `${project_name}-product-images-${account_id}`.
- **Secrets in plaintext**: Docker compose written to `/opt/shopmesh/backend/docker-compose.yml` with all environment variables in plaintext — exposed to any process with filesystem access.

**`scripts/frontend-userdata.sh`**
- Same `git clone` fallback risk as backend.
- `REACT_APP_INTERNAL_ALB_URL` passed as a Docker build arg in the fallback path — this bakes the internal ALB DNS into the React bundle at build time. The ECR + nginx `envsubst` approach injects it at runtime correctly (preferred).

---

## PART 2 — COMPLETE SYSTEM REVIEW

---

### Architecture Overview

```
Internet
   │
   ▼
CloudFront Distribution (CDN + TLS termination, shopmesh.shop)
   │  /api/*: no cache, forward all headers
   │  /static/*: 1 year cache
   │  default: no cache (SPA shell)
   ▼
External ALB (public subnets, HTTP→HTTPS redirect)
   │  :443 → Frontend Target Group
   ▼
Frontend EC2 ASG (public subnets, t3.small)
 └── Docker: nginx:1.25-alpine
      │  React SPA (CRA build)
      │  nginx proxies /api/* → Internal ALB
      ▼
Internal ALB (private subnets, HTTP :80)
  ├── /api/auth/*     → Auth Target Group    (port 3001)
  ├── /api/products/* → Product Target Group (port 3002)
  └── /api/orders/*   → Order Target Group   (port 3003)
      ▼
Backend EC2 ASG (private subnets, t3.small)
 └── Docker Compose:
      ├── auth-service    (Node.js 20, Express)   :3001
      ├── product-service (Node.js 20, Express)   :3002
      └── order-service   (Python 3.11, FastAPI)  :3003

AWS Services:
  DynamoDB PAY_PER_REQUEST:
    ├── shopmesh-users       (GSI: email-index)
    ├── shopmesh-products
    └── shopmesh-orders      (GSI: user_id-index)

  SNS:
    ├── shopmesh-orders  ← order.created, order.status_changed, daily summary
    └── shopmesh-alerts  ← product.deleted, order failures, CloudWatch alarms

  SQS:
    ├── shopmesh-order-processing     (main queue, 1-day retention)
    └── shopmesh-order-processing-dlq (DLQ, 14-day retention)

  S3:
    ├── shopmesh-product-images-{account_id}
    ├── shopmesh-alb-logs-{account_id}
    └── shopmesh-cloudfront-logs-{account_id}

  Secrets Manager:
    ├── shopmesh/jwt-secret   (manually created — not Terraform-managed)
    └── shopmesh/app-config   (manually created — not Terraform-managed)

  ECR (4 repositories): frontend, auth-service, product-service, order-service
  EventBridge: 3 scheduled rules (daily summary, hourly health, weekly cleanup)
  CloudWatch: 5 alarms, 3 log groups
  Route53: Hosted zone, ACM validation CNAME, A aliases to CloudFront
```

**Data Flow — Order Creation:**
```
1. Browser → CloudFront → External ALB → nginx (frontend EC2)
2. nginx proxies POST /api/orders → Internal ALB → order-service
3. order-service validates JWT → HTTP call to auth-service /api/auth/validate
4. order-service fetches product details → HTTP call to product-service /api/products/{id} (per item, sequential)
5. order-service writes order to DynamoDB (shopmesh-orders)
6. order-service sends event to SQS (shopmesh-order-processing)
7. order-service publishes to SNS (shopmesh-orders)
8. SQS consumer thread picks up the event
9. Consumer transitions order: pending → confirmed
10. Consumer publishes SNS status change notification
```

---

### Strengths

1. **Solid secrets management** in auth and product services: AWS Secrets Manager at startup, fail-fast if unavailable.
2. **IAM least-privilege design**: Per-service-type IAM roles, per-service policy statements scoped to specific resources.
3. **VPC architecture is sound**: Public/private subnet split, per-AZ NAT gateways, VPC gateway endpoints for DynamoDB and S3.
4. **Security group chain**: External ALB → Frontend SG → Internal ALB SG → Backend SG forms proper defense-in-depth.
5. **SSH-less access**: SSM Session Manager replaces SSH keys entirely.
6. **DynamoDB PITR enabled**: Point-in-time recovery on all three tables — up to 35 days of restore capability.
7. **CloudFront properly configured**: HTTPS-only to origin, aggressive static asset caching, SPA 404 fallback, TLS 1.2 minimum.
8. **Containerized microservices**: Non-root users, minimal base images, HEALTHCHECK instructions, ECR lifecycle policies.
9. **Async FastAPI with proper lifespan management**: SQS consumer starts and stops with the application lifecycle.
10. **Repository pattern**: Business logic separated from route handlers in all three services.
11. **Terraform modular design**: 12 focused modules, remote state in S3 with DynamoDB locking, `default_tags` applied globally.
12. **ALB access logs**: Both internal and external ALBs log to S3 — supports security investigations.

---

### Weaknesses

1. **DynamoDB `ScanCommand` on every product list request** — catastrophic at scale.
2. **All three backend services on one EC2 instance** — no isolation, shared IAM role, resource contention.
3. **No stock decrement on order creation** — overselling is possible.
4. **Order service has no Secrets Manager integration** — secrets come from environment variables in a plaintext docker-compose.yml on disk.
5. **Sequential async calls in `create_order`** — O(n) HTTP calls, each serialized.
6. **CORS is `*` on all three services** — no origin restriction.
7. **JWT in localStorage** — XSS vulnerability.
8. **No WAF** on CloudFront or external ALB.
9. **No rate limiting** on auth endpoints.
10. **Secrets Manager resources commented out in Terraform** — manual step required, violates IaC principle.
11. **Duplicate auth middleware** across two services.
12. **EventBridge rules have no functional consumers** — scheduled events fire but nothing processes them.
13. **SQS main queue retention is 1 day** — too short; events lost if consumer is down.
14. **No CI/CD pipeline** visible in the codebase.
15. **Frontend ASG EC2 in public subnets with public IPs** — ALB is the intended ingress.
16. **`aioboto3` installed but unused** — async AWS SDK never used, causing sync blocking in FastAPI.
17. **Hardcoded GitHub URL in userdata fallback** — supply chain risk.

---

### Security Audit

#### Authentication
| Aspect | Status | Detail |
|---|---|---|
| Password hashing | ✅ | bcryptjs with cost factor 12 |
| JWT algorithm pinning | ❌ | `algorithms` option not specified — accepts any algorithm |
| Token expiry | ✅ | 24 hours |
| Token refresh | ❌ | No refresh token mechanism |
| Token storage | ❌ | localStorage — XSS-accessible |
| Brute force protection | ❌ | No rate limiting on login/register |
| Password policy | ⚠️ | Minimum 6 chars — too weak |

#### Authorization
| Aspect | Status | Detail |
|---|---|---|
| Product write access | ❌ | Any authenticated user can create/update/delete products |
| Order access control | ✅ | Owner or admin role checked in routes |
| Order status transitions | ✅ | Users can only cancel; admin can set any status |
| `/validate` endpoint exposure | ⚠️ | Unauthenticated, reachable from frontend, returns decoded JWT payload |

#### Secrets Management
| Aspect | Status | Detail |
|---|---|---|
| Auth service secrets | ✅ | AWS Secrets Manager at startup |
| Product service secrets | ✅ | AWS Secrets Manager at startup |
| Order service secrets | ❌ | Environment variables in plaintext docker-compose on disk |
| Terraform secret creation | ❌ | Commented out — manual creation required |
| JWT secret in comments | ⚠️ | `"ShopMeshDemoJWTSecret2026!"` visible in `secretsmanager/main.tf` |

#### Network Security
| Aspect | Status | Detail |
|---|---|---|
| Public exposure | ✅ | Only CloudFront/external ALB reachable from internet |
| Internal traffic | ✅ | Security group chain prevents direct access |
| Internal traffic encryption | ❌ | HTTP between nginx and backend, HTTP on internal ALB |
| WAF | ❌ | No WAF on CloudFront or ALB |
| CORS | ❌ | Wildcard `*` on all three services |
| CSP headers | ❌ | No Content-Security-Policy in nginx |

#### IAM
| Aspect | Status | Detail |
|---|---|---|
| Role-per-function | ⚠️ | Per-tier (frontend/backend) but not per-service |
| DynamoDB scope | ✅ | Scoped to specific table ARNs |
| CloudWatch scope | ⚠️ | `Resource: "*"` for log operations |
| ECR scope | ⚠️ | `GetAuthorizationToken` requires `*` (AWS constraint) |
| No inline admin policies | ✅ | All policies are attached role policies |

---

### Scalability Analysis

**Where the system will fail first:**

1. **`listProducts` DynamoDB scan** — at ~1,000 products, latency becomes noticeable. At 10,000 products, a scan reads multiple MB per request. With 10 concurrent users each loading the product page, DynamoDB is doing 10 full-table scans simultaneously. **This is the single most critical scalability bottleneck.**

2. **All backend services on one t3.small** — 2 vCPU and 2 GB RAM shared by three services plus Docker overhead. bcrypt operations in auth-service are CPU-bound; simultaneous login attempts will starve the other services.

3. **SQS consumer single-threaded** — processes messages serially at ~1 order/3-5 seconds. At 1,000 orders/minute, the queue would back up within minutes.

4. **Sequential inter-service HTTP calls** — each order creation makes N+1 synchronous HTTP calls (1 auth validate + N product fetches). A 5-item cart with 5-second timeouts = up to 30 seconds worst case.

5. **ASG max=1** — no auto-scaling is active. Traffic spikes cannot be absorbed.

**What can handle load:**
- DynamoDB PAY_PER_REQUEST scales automatically for point-reads.
- CloudFront scales transparently.
- ALB scales transparently.
- Static assets are cached by CloudFront and browser.

---

### DevOps & Infrastructure Review

**Terraform Quality:**
- Module structure is clean and reusable — each module has a focused responsibility.
- `default_tags` ensures all resources are tagged for cost tracking.
- Remote state with S3+DynamoDB locking is production-grade.
- `create_before_destroy` on ACM certificates and ASGs prevents downtime during updates.
- `depends_on` chains are correctly specified where Terraform can't infer them.

**Weaknesses in Terraform:**
- Commented-out code in `providers.tf` and `versions.tf` is cluttered and should be removed.
- `terraform.tfvars` contains `alert_email = "saidevops753@gmail.com"` — PII in version control.
- Secrets Manager resources are not managed by Terraform — a manual pre-apply step breaks the IaC story.
- `tfplan` binary file is committed to the repository — state plan files should not be committed.

**CI/CD Readiness:**
There is **no CI/CD pipeline visible**. No Jenkinsfile, GitHub Actions workflow, CircleCI config, or CodePipeline definition. Deployments require:
1. Manual `docker build` and `docker push` to ECR.
2. Manual `terraform apply` for infrastructure changes.
3. ASG instance refresh triggered manually or by launch template version bump.

---

## PART 3 — FINAL RECOMMENDATIONS (PRIORITIZED)

---

### CRITICAL — Fix Immediately

**1. Add JWT algorithm pinning** in both `auth.js` middleware files:
```js
const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
```

**2. Replace `ScanCommand` in `listProducts` with a GSI query.**
Add a GSI on the products table with hash key `isActive` and sort key `category`. This is a DynamoDB schema change requiring a data migration.

**3. Implement stock decrement as part of order creation.**
Use a DynamoDB conditional update (decrement stock only if ≥ requested quantity) to prevent overselling:
```python
table.update_item(
    Key={"productId": product_id},
    UpdateExpression="SET stock = stock - :qty",
    ConditionExpression="stock >= :qty",
    ExpressionAttributeValues={":qty": quantity}
)
```

**4. Restrict CORS on all three services:**
```js
app.use(cors({ origin: 'https://shopmesh.shop' }));
```

**5. Add rate limiting on auth endpoints:**
```js
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
router.post('/login', loginLimiter, [...]);
router.post('/register', loginLimiter, [...]);
```

**6. Fix the S3 bucket name in backend userdata** (line 132 — missing account ID suffix):
Change `S3_PRODUCT_IMAGES_BUCKET=$PROJECT_NAME-product-images` to use the full bucket name with account ID.

---

### HIGH — Fix Within 1 Sprint

**7. Move JWT from localStorage to httpOnly cookies.**
Requires changes to auth service (set cookie on login/register) and all API calls (`withCredentials: true`). Adds CSRF token requirement.

**8. Use `asyncio.gather()` for parallel product fetches** in `order-service/app/routes/orders.py`:
```python
products = await asyncio.gather(*[get_product_details(item.product_id) for item in order_data.items])
```

**9. Create a shared `httpx.AsyncClient` with lifespan** instead of per-request clients in `dependencies.py`:
```python
@asynccontextmanager
async def lifespan(app):
    app.state.http_client = httpx.AsyncClient(timeout=5.0)
    yield
    await app.state.http_client.aclose()
```

**10. Replace synchronous boto3 SNS/SQS calls with `aioboto3`** in the order service (package already installed but unused).

**11. Add role-based authorization to product write endpoints:**
```js
router.post('/', authMiddleware, (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
}, [...validation], createProductHandler);
```

**12. Add Secrets Manager integration to the order service** — mirror the `loadSecrets()` pattern from auth/product services.

**13. Un-comment and restore the Secrets Manager Terraform resources** — manage secrets through IaC. Remove the hardcoded JWT secret value from the commented code.

**14. Increase SQS main queue retention** from `86400` (1 day) to `604800` (7 days).

**15. Add sort key (`created_at`) to `user_id-index` GSI** in orders table to eliminate in-memory sorting.

---

### MEDIUM — Backlog

**16. Separate backend services into their own ASGs/instances** for true service isolation and individual scaling. Consider migrating to ECS Fargate for per-service task roles and easier scaling.

**17. Add AWS WAF** to CloudFront distribution with AWS Managed Core Rule Set and rate-based rules.

**18. Implement a CI/CD pipeline** (GitHub Actions example):
```yaml
# .github/workflows/deploy.yml
- Build Docker images
- Push to ECR
- Run terraform plan / apply
- Trigger ASG instance refresh
```

**19. Disable FastAPI OpenAPI docs in production:**
```python
app = FastAPI(docs_url=None, redoc_url=None, ...)
```

**20. Add Content-Security-Policy header** to nginx.conf:
```nginx
add_header Content-Security-Policy "default-src 'self'; img-src 'self' https://images.unsplash.com data:; script-src 'self'; style-src 'self' 'unsafe-inline';" always;
```

**21. Implement server-side pagination in `listProducts`** using DynamoDB `LastEvaluatedKey` and expose cursor-based pagination to the frontend.

**22. Add graceful shutdown handlers** to both Node.js services:
```js
process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
```

**23. Persist the shopping cart** to localStorage to survive page refreshes.

**24. Fix the `product._id` undefined bug** in `ProductsPage.js` line 86:
```js
// Change from:
setAddedMap(prev => ({ ...prev, [product._id]: true }));
// To:
const pid = product.productId || product._id;
setAddedMap(prev => ({ ...prev, [pid]: true }));
```

**25. Remove the `tfplan` binary from the repository** and add `*.tfplan` to `.gitignore`.

**26. Remove `alert_email` from `terraform.tfvars`** and pass it as a CI/CD environment variable.

**27. Delete the hardcoded GitHub fallback** in both userdata scripts. If ECR is empty, the deployment should fail explicitly, not silently pull from a public repository.

**28. Restore the CloudWatch dashboard** (currently commented out) and add monitoring for all three target groups — not just auth.

**29. Implement token refresh**: Add `POST /api/auth/refresh` using a long-lived refresh token in an httpOnly cookie.

**30. Increase minimum password length** from 6 to 12 characters in both client-side and server-side validation.

**31. Increase SQS visibility timeout** from 30 seconds to 60–90 seconds on both the queue definition and the consumer receive call.

**32. Fix DynamoDB throttle alarm metric**: Change `UserErrors` to `ThrottledRequests` in the CloudWatch alarm.

**33. Remove frontend EC2 public IPs**: Move frontend ASG to private subnets or disable `map_public_ip_on_launch` since the external ALB handles all inbound traffic.

**34. Eliminate duplicate auth middleware**: Extract to a shared npm package or git submodule so `auth.js` is maintained in one place across auth and product services.
