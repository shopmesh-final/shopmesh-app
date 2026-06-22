const express = require('express');
const { body, validationResult } = require('express-validator');
const productRepo = require('../repositories/productRepository');
const authMiddleware = require('../middleware/auth');
const snsService = require('../services/snsService');
const s3Service = require('../services/s3Service');

const router = express.Router();

// GET /api/products - list all active products (public)
router.get('/', async (req, res) => {
  try {
    const { category, minPrice, maxPrice, search, page, limit } = req.query;
    const result = await productRepo.listProducts({ category, minPrice, maxPrice, search, page, limit });
    res.status(200).json(result);
  } catch (err) {
    console.error(`[PRODUCT] List error: ${err.message}`);
    res.status(500).json({ error: 'Failed to retrieve products' });
  }
});

// GET /api/products/:id - get single product (public)
router.get('/:id', async (req, res) => {
  try {
    const product = await productRepo.getProductById(req.params.id);
    if (!product || !product.isActive) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(200).json({ product });
  } catch (err) {
    console.error(`[PRODUCT] Get error: ${err.message}`);
    res.status(500).json({ error: 'Failed to retrieve product' });
  }
});

// POST /api/products - create product (protected)
router.post(
  '/',
  authMiddleware,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('description').trim().notEmpty().withMessage('Description is required'),
    body('price').isFloat({ min: 0 }).withMessage('Valid price required'),
    body('category')
      .isIn(productRepo.VALID_CATEGORIES)
      .withMessage('Valid category required'),
    body('stock').isInt({ min: 0 }).withMessage('Valid stock required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const product = await productRepo.createProduct(req.body);
      console.log(`[PRODUCT] Created product: ${product.name} (${product.productId})`);

      // Publish SNS event (non-blocking)
      snsService.publishProductCreated(product).catch(() => {});

      res.status(201).json({ message: 'Product created successfully', product });
    } catch (err) {
      console.error(`[PRODUCT] Create error: ${err.message}`);
      res.status(500).json({ error: 'Failed to create product' });
    }
  }
);

// PUT /api/products/:id - update product (protected)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const product = await productRepo.updateProduct(req.params.id, req.body);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    console.log(`[PRODUCT] Updated product: ${product.productId}`);
    res.status(200).json({ message: 'Product updated successfully', product });
  } catch (err) {
    console.error(`[PRODUCT] Update error: ${err.message}`);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE /api/products/:id - soft delete product (protected)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const product = await productRepo.softDeleteProduct(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    console.log(`[PRODUCT] Deleted product: ${product.productId}`);

    // Publish SNS alert (non-blocking)
    snsService.publishProductDeleted(product.productId, product.name).catch(() => {});

    res.status(200).json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error(`[PRODUCT] Delete error: ${err.message}`);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// POST /api/products/:id/upload-url - get presigned upload URL
router.post('/:id/upload-url', authMiddleware, async (req, res) => {
  try {
    const { contentType = 'image/jpeg' } = req.body;
    const result = await s3Service.getUploadPresignedUrl(req.params.id, contentType);
    res.status(200).json(result);
  } catch (err) {
    console.error(`[PRODUCT] Upload URL error: ${err.message}`);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// PATCH /api/products/:id/decrement-stock - atomic stock decrement (called by order-service)
router.patch('/:id/decrement-stock', authMiddleware, async (req, res) => {
  try {
    const qty = parseInt(req.body.quantity, 10);
    if (!qty || qty < 1) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }
    const result = await productRepo.decrementStock(req.params.id, qty);
    if (!result.success) {
      return res.status(409).json({ success: false, message: 'Insufficient stock available' });
    }
    const updatedProduct = result.product;
    console.log(`[PRODUCT] Stock decremented: ${req.params.id} → remaining: ${updatedProduct.stock}`);
    if (typeof updatedProduct.stock === 'number' && updatedProduct.stock < 5) {
      snsService.publishLowStockAlert(updatedProduct).catch((err) =>
        console.error(`[PRODUCT] Low stock alert failed: ${err.message}`)
      );
    }
    res.status(200).json({ success: true, product: updatedProduct });
  } catch (err) {
    console.error(`[PRODUCT] Decrement stock error: ${err.message}`);
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// PATCH /api/products/:id/restore-stock - restore stock for order rollback
router.patch('/:id/restore-stock', authMiddleware, async (req, res) => {
  try {
    const qty = parseInt(req.body.quantity, 10);
    if (!qty || qty < 1) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }
    await productRepo.restoreStock(req.params.id, qty);
    console.log(`[PRODUCT] Stock restored: ${req.params.id} +${qty}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(`[PRODUCT] Restore stock error: ${err.message}`);
    res.status(500).json({ error: 'Failed to restore stock' });
  }
});

module.exports = router;
