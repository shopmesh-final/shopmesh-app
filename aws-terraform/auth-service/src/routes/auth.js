const express = require('express');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const userRepo = require('../repositories/userRepository');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// JWT config is loaded from process.env by index.js (via Secrets Manager at startup)
const getJwtSecret = () => process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// POST /api/auth/register
router.post(
  '/register',
  [
    body('name').trim().isLength({ min: 2, max: 50 }).withMessage('Name must be 2-50 characters'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('gender').isIn(['Male', 'Female', 'Other']).withMessage('Gender must be Male, Female, or Other'),
    body('age').isInt({ min: 13, max: 100 }).withMessage('Age must be an integer between 13 and 100')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password, gender, age } = req.body;
    try {
      const existingUser = await userRepo.findByEmail(email);
      if (existingUser) {
        return res.status(409).json({ error: 'User with this email already exists' });
      }

      const user = await userRepo.createUser({ name, email, password, gender, age: parseInt(age, 10) });

      const token = jwt.sign(
        { userId: user.userId, email: user.email, role: user.role },
        getJwtSecret(),
        { expiresIn: JWT_EXPIRES_IN }
      );

      console.log(`[AUTH] User registered: ${email}`);
      res.status(201).json({ message: 'User registered successfully', token, user });
    } catch (err) {
      console.error(`[AUTH] Registration error: ${err.message}`);
      res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    try {
      const user = await userRepo.findByEmail(email);
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const isMatch = await userRepo.verifyPassword(password, user.passwordHash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign(
        { userId: user.userId, email: user.email, role: user.role },
        getJwtSecret(),
        { expiresIn: JWT_EXPIRES_IN }
      );

      console.log(`[AUTH] User logged in: ${email}`);
      res.status(200).json({
        message: 'Login successful',
        token,
        user: userRepo.sanitizeUser(user)
      });
    } catch (err) {
      console.error(`[AUTH] Login error: ${err.message}`);
      res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }
);

// GET /api/auth/me - get current user profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await userRepo.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(200).json({ user: userRepo.sanitizeUser(user) });
  } catch (err) {
    console.error(`[AUTH] Get profile error: ${err.message}`);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

// POST /api/auth/validate - validate JWT token (used by other services)
router.post('/validate', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    res.status(200).json({ valid: true, user: decoded });
  } catch (err) {
    res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
});

module.exports = router;
