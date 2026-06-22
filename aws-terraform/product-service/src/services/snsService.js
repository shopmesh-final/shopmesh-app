const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const LOCAL_MODE = process.env.LOCAL_MODE === 'true';

let snsClient = null;

if (!LOCAL_MODE) {
  snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });
}

/**
 * Publish a message to an SNS topic.
 * In LOCAL_MODE, log the message instead.
 */
const publish = async (topicArn, subject, message) => {
  if (LOCAL_MODE) {
    console.log(`[SNS-LOCAL] Subject: ${subject} | Message: ${JSON.stringify(message)}`);
    return;
  }

  try {
    await snsClient.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: subject,
        Message: typeof message === 'string' ? message : JSON.stringify(message),
        MessageAttributes: {
          service: { DataType: 'String', StringValue: 'product-service' }
        }
      })
    );
    console.log(`[SNS] Published to ${topicArn}: ${subject}`);
  } catch (err) {
    console.error(`[SNS] Publish failed: ${err.message}`);
    // Non-fatal — don't crash the service
  }
};

const publishProductCreated = async (product) => {
  const topicArn = process.env.SNS_ORDERS_TOPIC_ARN || '';
  if (!topicArn && !LOCAL_MODE) return;
  await publish(topicArn, 'ProductCreated', { event: 'product.created', product });
};

const publishProductDeleted = async (productId, productName) => {
  const topicArn = process.env.SNS_ALERTS_TOPIC_ARN || '';
  if (!topicArn && !LOCAL_MODE) return;
  await publish(topicArn, 'ProductDeleted', { event: 'product.deleted', productId, productName });
};

const publishLowStockAlert = async (product) => {
  const topicArn = process.env.SNS_ALERTS_TOPIC_ARN || '';
  if (!topicArn && !LOCAL_MODE) return;
  const message = `LOW INVENTORY ALERT\n\nProduct: ${product.name}\nProduct ID: ${product.productId}\nRemaining Stock: ${product.stock}`;
  await publish(topicArn, 'LowStockAlert', {
    event: 'product.low_stock',
    message,
    product_id: product.productId,
    product_name: product.name,
    remaining_stock: product.stock
  });
};

module.exports = { publish, publishProductCreated, publishProductDeleted, publishLowStockAlert };
