const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const LOCAL_MODE = process.env.LOCAL_MODE === 'true';

const clientConfig = LOCAL_MODE
  ? {
      region: 'us-east-1',
      endpoint: process.env.DYNAMODB_ENDPOINT || 'http://dynamodb-local:8000',
      credentials: {
        accessKeyId: 'local',
        secretAccessKey: 'local'
      }
    }
  : {
      region: process.env.AWS_REGION || 'us-east-1'
    };

const rawClient = new DynamoDBClient(clientConfig);

const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true
  }
});

const PRODUCTS_TABLE = process.env.DYNAMODB_PRODUCTS_TABLE || 'shopmesh-products';

module.exports = { docClient, PRODUCTS_TABLE };
