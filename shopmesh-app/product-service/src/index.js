require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require('@aws-sdk/client-secrets-manager');

const productRoutes = require('./routes/products');
const productRepo = require('./repositories/productRepository');

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    service: 'product-service',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/products', productRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[PRODUCT-SERVICE ERROR] ${err.stack}`);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    service: 'product-service'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', service: 'product-service' });
});

/**
 * Load secrets from AWS Secrets Manager.
 * In LOCAL_MODE, skip and use .env values.
 */
const loadSecrets = async () => {
  if (process.env.LOCAL_MODE === 'true') {
    console.log('[PRODUCT-SERVICE] LOCAL_MODE=true — using .env for secrets');
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = 'local-dev-jwt-secret-change-in-production';
      console.warn('[PRODUCT-SERVICE] WARNING: Using default JWT_SECRET for local dev');
    }
    return;
  }

  const region = process.env.AWS_REGION || 'us-east-1';
  const client = new SecretsManagerClient({ region });

  try {
    console.log('[PRODUCT-SERVICE] Loading secrets from AWS Secrets Manager...');

    const jwtSecretRes = await client.send(
      new GetSecretValueCommand({ SecretId: 'shopmesh/jwt-secret' })
    );
    const jwtData = JSON.parse(jwtSecretRes.SecretString);
    process.env.JWT_SECRET = jwtData.jwt_secret;

    console.log('[PRODUCT-SERVICE] Secrets loaded successfully');
  } catch (err) {
    console.error(`[PRODUCT-SERVICE] Failed to load secrets: ${err.message}`);
    process.exit(1);
  }
};

const start = async () => {
  await loadSecrets();

  // Seed DynamoDB — idempotent, only inserts products not already present by name
  try {
    await productRepo.seedProducts();
  } catch (err) {
    console.error(`[PRODUCT-SERVICE] Seeding failed: ${err.message}`);
    // Non-fatal — allow startup to continue
  }

  app.listen(PORT, () => {
    console.log(`[PRODUCT-SERVICE] Running on port ${PORT}`);
  });
};

start();
