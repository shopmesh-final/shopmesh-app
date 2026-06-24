require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require('@aws-sdk/client-secrets-manager');

const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    service: 'auth-service',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/auth', authRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[AUTH-SERVICE ERROR] ${err.stack}`);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    service: 'auth-service'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', service: 'auth-service' });
});

/**
 * Load secrets from AWS Secrets Manager.
 * In LOCAL_MODE, skip and use .env values.
 */
const loadSecrets = async () => {
  if (process.env.LOCAL_MODE === 'true') {
    console.log('[AUTH-SERVICE] LOCAL_MODE=true — using .env for secrets');
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = 'local-dev-jwt-secret-change-in-production';
      console.warn('[AUTH-SERVICE] WARNING: Using default JWT_SECRET for local dev');
    }
    return;
  }

  const region = process.env.AWS_REGION || 'us-east-1';
  const client = new SecretsManagerClient({ region });

  try {
    console.log('[AUTH-SERVICE] Loading secrets from AWS Secrets Manager...');

    const jwtSecretRes = await client.send(
      new GetSecretValueCommand({ SecretId: 'shopmesh/jwt-secret' })
    );
    const jwtData = JSON.parse(jwtSecretRes.SecretString);
    process.env.JWT_SECRET = jwtData.jwt_secret;

    const appConfigRes = await client.send(
      new GetSecretValueCommand({ SecretId: 'shopmesh/app-config' })
    );
    const appConfig = JSON.parse(appConfigRes.SecretString);
    process.env.JWT_EXPIRES_IN = appConfig.jwt_expires_in || '24h';

    console.log('[AUTH-SERVICE] Secrets loaded successfully');
  } catch (err) {
    console.error(`[AUTH-SERVICE] Failed to load secrets: ${err.message}`);
    process.exit(1);
  }
};

const start = async () => {
  await loadSecrets();
  app.listen(PORT, () => {
    console.log(`[AUTH-SERVICE] Running on port ${PORT}`);
  });
};

start();
