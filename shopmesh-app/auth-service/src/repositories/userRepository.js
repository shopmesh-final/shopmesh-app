const {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand
} = require('@aws-sdk/lib-dynamodb');
const { docClient, USERS_TABLE } = require('../db/dynamodb');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

/**
 * Find a user by email using the GSI (email-index).
 */
const findByEmail = async (email) => {
  const result = await docClient.send(
    new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: { ':email': email.toLowerCase() },
      Limit: 1
    })
  );
  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
};

/**
 * Find a user by userId (primary key).
 */
const findById = async (userId) => {
  const result = await docClient.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId }
    })
  );
  return result.Item || null;
};

/**
 * Create a new user. Returns the user object without the password.
 */
const createUser = async ({ name, email, password, role = 'user', gender, age }) => {
  const salt = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(password, salt);
  const now = new Date().toISOString();
  const userId = uuidv4();

  const item = {
    userId,
    name: name.trim(),
    email: email.toLowerCase().trim(),
    passwordHash,
    role,
    gender,
    age: parseInt(age, 10),
    createdAt: now,
    updatedAt: now
  };

  await docClient.send(
    new PutCommand({
      TableName: USERS_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(userId)'
    })
  );

  const { passwordHash: _ph, ...safeUser } = item;
  return safeUser;
};

/**
 * Verify a candidate password against stored hash.
 */
const verifyPassword = async (candidatePassword, passwordHash) => {
  return bcrypt.compare(candidatePassword, passwordHash);
};

/**
 * Strip passwordHash before returning to clients.
 */
const sanitizeUser = (user) => {
  if (!user) return null;
  const { passwordHash: _ph, ...safe } = user;
  return safe;
};

module.exports = { findByEmail, findById, createUser, verifyPassword, sanitizeUser };
