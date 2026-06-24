const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const LOCAL_MODE = process.env.LOCAL_MODE === 'true';
const BUCKET = process.env.S3_PRODUCT_IMAGES_BUCKET || 'shopmesh-product-images';

let s3Client = null;

if (!LOCAL_MODE) {
  s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
}

/**
 * Generate a presigned URL for uploading a product image.
 * @param {string} productId
 * @param {string} contentType e.g. 'image/jpeg'
 * @param {number} expiresIn seconds (default 300)
 */
const getUploadPresignedUrl = async (productId, contentType = 'image/jpeg', expiresIn = 300) => {
  if (LOCAL_MODE) {
    return {
      uploadUrl: `http://localhost:4566/${BUCKET}/products/${productId}`,
      imageUrl: `http://localhost:4566/${BUCKET}/products/${productId}`,
      note: 'LOCAL_MODE: Presigned URL is simulated'
    };
  }

  const key = `products/${productId}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });
  const imageUrl = `https://${BUCKET}.s3.amazonaws.com/${key}`;

  return { uploadUrl, imageUrl };
};

/**
 * Generate a presigned URL for downloading/viewing a product image.
 */
const getDownloadPresignedUrl = async (productId, expiresIn = 3600) => {
  if (LOCAL_MODE) {
    return `http://localhost:4566/${BUCKET}/products/${productId}`;
  }

  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: `products/${productId}`
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

module.exports = { getUploadPresignedUrl, getDownloadPresignedUrl, BUCKET };
