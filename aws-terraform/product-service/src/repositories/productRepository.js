const {
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  QueryCommand
} = require('@aws-sdk/lib-dynamodb');
const { docClient, PRODUCTS_TABLE } = require('../db/dynamodb');
const { v4: uuidv4 } = require('uuid');

const VALID_CATEGORIES = [
  'Electronics', 'Clothing', 'Books', 'Food',
  'Furniture', 'Sports', 'Toys', 'Beauty', 'Other'
];

/**
 * List active products with optional filters.
 * Uses a Scan (DynamoDB Local/small dataset) with FilterExpression.
 * For production scale, use a GSI on isActive+category.
 */
const listProducts = async ({ category, minPrice, maxPrice, search, page = 1, limit = 20 }) => {
  const filterParts = ['isActive = :active'];
  const exprValues = { ':active': true };

  if (category) {
    filterParts.push('category = :cat');
    exprValues[':cat'] = category;
  }
  if (minPrice !== undefined) {
    filterParts.push('price >= :minp');
    exprValues[':minp'] = parseFloat(minPrice);
  }
  if (maxPrice !== undefined) {
    filterParts.push('price <= :maxp');
    exprValues[':maxp'] = parseFloat(maxPrice);
  }

  const params = {
    TableName: PRODUCTS_TABLE,
    FilterExpression: filterParts.join(' AND '),
    ExpressionAttributeValues: exprValues
  };

  const result = await docClient.send(new ScanCommand(params));
  let items = result.Items || [];

  // In-memory search (DynamoDB doesn't have full-text search natively)
  if (search) {
    const lower = search.toLowerCase();
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(lower) ||
        p.description.toLowerCase().includes(lower)
    );
  }

  // Sort by createdAt descending
  items.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

  const total = items.length;
  const startIdx = (parseInt(page) - 1) * parseInt(limit);
  const paginated = items.slice(startIdx, startIdx + parseInt(limit));

  return {
    products: paginated,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit))
    }
  };
};

/**
 * Get a single product by productId.
 */
const getProductById = async (productId) => {
  const result = await docClient.send(
    new GetCommand({
      TableName: PRODUCTS_TABLE,
      Key: { productId }
    })
  );
  return result.Item || null;
};

/**
 * Create a new product item.
 */
const createProduct = async ({ name, description, price, category, stock, imageUrl, rating, reviewCount, originalPrice }) => {
  const now = new Date().toISOString();
  const productId = uuidv4();

  const item = {
    productId,
    name: name.trim(),
    description: description.trim(),
    price: parseFloat(price),
    category,
    stock: parseInt(stock),
    imageUrl: imageUrl || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
    isActive: true,
    createdAt: now,
    updatedAt: now
  };

  if (rating       != null) item.rating       = parseFloat(rating);
  if (reviewCount  != null) item.reviewCount  = parseInt(reviewCount);
  if (originalPrice != null) item.originalPrice = parseFloat(originalPrice);

  await docClient.send(
    new PutCommand({
      TableName: PRODUCTS_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(productId)'
    })
  );

  return item;
};

/**
 * Update an existing product. Returns updated item.
 */
const updateProduct = async (productId, updates) => {
  const existing = await getProductById(productId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updatable = { ...existing, ...updates, productId, updatedAt: now };

  await docClient.send(
    new PutCommand({ TableName: PRODUCTS_TABLE, Item: updatable })
  );

  return updatable;
};

/**
 * Soft-delete a product by setting isActive=false.
 */
const softDeleteProduct = async (productId) => {
  const existing = await getProductById(productId);
  if (!existing) return null;

  const updated = { ...existing, isActive: false, updatedAt: new Date().toISOString() };
  await docClient.send(new PutCommand({ TableName: PRODUCTS_TABLE, Item: updated }));
  return updated;
};

/**
 * Count all active products (used for seeding check).
 */
const countActiveProducts = async () => {
  const result = await docClient.send(
    new ScanCommand({
      TableName: PRODUCTS_TABLE,
      FilterExpression: 'isActive = :a',
      ExpressionAttributeValues: { ':a': true },
      Select: 'COUNT'
    })
  );
  return result.Count || 0;
};

/**
 * Seed initial products if table is empty.
 */
const seedProducts = async () => {
  const sampleProducts = [
    { name: 'Wireless Noise-Cancelling Headphones', description: 'Premium sound quality with 30-hour battery life and foldable design.', price: 299.99, originalPrice: 349.99, category: 'Electronics', stock: 50, imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400', rating: 4.7, reviewCount: 2143 },
    { name: 'Mechanical Gaming Keyboard', description: 'RGB backlit mechanical keyboard with tactile switches and N-key rollover.', price: 149.99, category: 'Electronics', stock: 75, imageUrl: 'https://images.unsplash.com/photo-1541140532154-b024d705b90a?w=400', rating: 4.6, reviewCount: 1582 },
    { name: 'Ergonomic Office Chair', description: 'Lumbar support, adjustable armrests, and breathable mesh back for all-day comfort.', price: 459.99, category: 'Furniture', stock: 20, imageUrl: 'https://images.unsplash.com/photo-1541558869434-2840d308329a?w=400', rating: 4.4, reviewCount: 891 },
    { name: 'Stainless Steel Water Bottle', description: 'Keeps drinks cold 24 hours or hot 12 hours, BPA-free with leak-proof lid.', price: 34.99, category: 'Sports', stock: 200, imageUrl: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=400', rating: 4.8, reviewCount: 4210 },
    { name: 'Smart Watch Pro', description: 'Health monitoring, GPS, sleep tracking, and 7-day battery life.', price: 399.99, category: 'Electronics', stock: 35, imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400', rating: 4.3, reviewCount: 763 },
    { name: 'Running Shoes Ultra Boost', description: 'Lightweight, responsive cushioning for everyday training and long runs.', price: 129.99, originalPrice: 159.99, category: 'Sports', stock: 100, imageUrl: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400', rating: 4.5, reviewCount: 3319 },
    { name: 'Portable Bluetooth Speaker', description: '360° surround sound, waterproof IPX7, 20-hour playtime.', price: 79.99, category: 'Electronics', stock: 60, imageUrl: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=400', rating: 4.6, reviewCount: 2187 },
    { name: 'Organic Coffee Blend', description: 'Single-origin, fair-trade Ethiopian coffee beans, medium roast.', price: 24.99, category: 'Food', stock: 150, imageUrl: 'https://images.unsplash.com/photo-1447933601403-0c6688de566e?w=400', rating: 4.9, reviewCount: 1044 },
    { name: 'Gaming Mouse Pro', description: 'Ultra-responsive 16,000 DPI sensor, ergonomic design, 8 programmable buttons, RGB lighting.', price: 79.99, category: 'Electronics', stock: 85, imageUrl: 'https://images.unsplash.com/photo-1527814050087-3793815479db?w=400', rating: 4.5, reviewCount: 312 },
    { name: 'Portable SSD 1TB', description: 'Ultra-fast USB-C 3.1 Gen 2, 1050MB/s read speed, durable aluminum shell, compact design.', price: 149.99, category: 'Electronics', stock: 7, imageUrl: 'https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?w=400', rating: 4.7, reviewCount: 587 },
    { name: 'USB-C Hub 7-in-1', description: '4K HDMI, 3x USB 3.0, SD card reader, aluminum construction, plug-and-play, universal compatibility.', price: 49.99, category: 'Electronics', stock: 120, imageUrl: 'https://images.unsplash.com/photo-1625948515291-69613efd103f?w=400', rating: 4.4, reviewCount: 1205 },
    { name: 'Wireless Charging Pad', description: '15W fast charging, Qi-certified, premium base, auto-sleep mode, works with all Qi-enabled phones.', price: 39.99, category: 'Electronics', stock: 95, imageUrl: 'https://images.unsplash.com/photo-1606933248051-5ce98a30b2b8?w=400', rating: 4.3, reviewCount: 892 },
    { name: 'Adjustable Phone Stand', description: 'Premium aluminum alloy, 360° rotation, foldable design, works with all phones and tablets.', price: 29.99, category: 'Electronics', stock: 150, imageUrl: 'https://images.unsplash.com/photo-1591437281548-f0b6f8e8bb44?w=400', rating: 4.2, reviewCount: 673 },
    { name: 'USB-C Fast Charging Cable', description: '65W power delivery, 2-meter braided nylon, quick charge enabled, 5-year warranty.', price: 19.99, originalPrice: 24.99, category: 'Electronics', stock: 200, imageUrl: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400', rating: 4.6, reviewCount: 2891 },
    { name: 'True Wireless Earbuds', description: 'Active noise cancellation, 28-hour total battery, IPX5 water resistance, Bluetooth 5.3.', price: 129.99, originalPrice: 159.99, category: 'Electronics', stock: 65, imageUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=400', rating: 4.6, reviewCount: 3872 },
    { name: '4K HD Webcam', description: '4K autofocus, dual microphones with noise cancellation, plug-and-play, works with all platforms.', price: 89.99, category: 'Electronics', stock: 45, imageUrl: 'https://images.unsplash.com/photo-1587826080692-f439cd0b70da?w=400', rating: 4.5, reviewCount: 1243 },
    { name: 'Portable Laptop Stand', description: 'Adjustable 6-angle aluminum stand, foldable, fits all laptops 10–17 inches, improves airflow.', price: 34.99, category: 'Electronics', stock: 110, imageUrl: 'https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=400', rating: 4.4, reviewCount: 876 },
    { name: 'Wireless Keyboard & Mouse Combo', description: '2.4GHz wireless, quiet keys, ergonomic mouse, 12-month battery life, multi-OS compatible.', price: 69.99, originalPrice: 89.99, category: 'Electronics', stock: 80, imageUrl: 'https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=400', rating: 4.4, reviewCount: 1543 },
    { name: 'Premium Yoga Mat', description: 'Non-slip natural rubber base, 6mm thickness, moisture-wicking surface, includes carry strap.', price: 54.99, category: 'Sports', stock: 90, imageUrl: 'https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=400', rating: 4.8, reviewCount: 3124 },
    { name: 'Resistance Bands Set', description: '5 resistance levels, natural latex, includes door anchor and handles, suitable for all fitness levels.', price: 24.99, category: 'Sports', stock: 180, imageUrl: 'https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=400', rating: 4.7, reviewCount: 4532 },
    { name: 'Whey Protein Powder', description: '25g protein per serving, vanilla flavor, 30 servings, low sugar, mixes instantly.', price: 49.99, originalPrice: 59.99, category: 'Food', stock: 120, imageUrl: 'https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=400', rating: 4.6, reviewCount: 2456 },
    { name: 'Premium Green Tea Set', description: 'Hand-picked Japanese matcha and sencha, 20 biodegradable bags, antioxidant-rich.', price: 22.99, category: 'Food', stock: 160, imageUrl: 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=400', rating: 4.8, reviewCount: 1678 },
    { name: 'Slim Minimalist Wallet', description: 'Genuine leather, RFID blocking, holds 8 cards + cash, slim 4mm profile, gift-box packaging.', price: 39.99, category: 'Clothing', stock: 140, imageUrl: 'https://images.unsplash.com/photo-1627123424574-724758594785?w=400', rating: 4.5, reviewCount: 1034 },
    { name: 'Smart LED Desk Lamp', description: 'Touch dimmer, 5 color temperatures, USB charging port, eye-care technology, foldable arm.', price: 44.99, category: 'Furniture', stock: 70, imageUrl: 'https://images.unsplash.com/photo-1534189499165-9c4f80af5e12?w=400', rating: 4.7, reviewCount: 1892 },
    { name: 'Bamboo Desk Organizer', description: 'Natural bamboo, 6 compartments, pen holder, phone slot, eco-friendly and sustainable.', price: 32.99, category: 'Furniture', stock: 95, imageUrl: 'https://images.unsplash.com/photo-1593642532973-d31b6557fa68?w=400', rating: 4.6, reviewCount: 987 },
    { name: 'Vitamin C Face Serum', description: '20% vitamin C, hyaluronic acid, niacinamide blend, brightens skin tone, dermatologist tested.', price: 54.99, originalPrice: 69.99, category: 'Beauty', stock: 85, imageUrl: 'https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=400', rating: 4.7, reviewCount: 2341 }
  ];

  // Fetch existing product names so we only insert what's missing
  const existing = await docClient.send(
    new ScanCommand({
      TableName: PRODUCTS_TABLE,
      FilterExpression: 'isActive = :a',
      ExpressionAttributeValues: { ':a': true },
      ProjectionExpression: '#n',
      ExpressionAttributeNames: { '#n': 'name' }
    })
  );
  const existingNames = new Set((existing.Items || []).map(i => i.name));

  let inserted = 0;
  for (const p of sampleProducts) {
    if (!existingNames.has(p.name)) {
      await createProduct(p);
      inserted++;
    }
  }
  if (inserted > 0) {
    console.log(`[PRODUCT-SERVICE] Seeded ${inserted} new products (${sampleProducts.length - inserted} already existed)`);
  } else {
    console.log(`[PRODUCT-SERVICE] All ${sampleProducts.length} products already present — skipping seed`);
  }
};

const decrementStock = async (productId, quantity) => {
  const qty = parseInt(quantity, 10);
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: PRODUCTS_TABLE,
        Key: { productId },
        UpdateExpression: 'SET stock = stock - :qty, updatedAt = :now',
        ConditionExpression: 'attribute_exists(productId) AND stock >= :qty',
        ExpressionAttributeValues: {
          ':qty': qty,
          ':now': new Date().toISOString()
        },
        ReturnValues: 'ALL_NEW'
      })
    );
    return { success: true, product: result.Attributes };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { success: false, reason: 'insufficient_stock' };
    }
    throw err;
  }
};

const restoreStock = async (productId, quantity) => {
  const qty = parseInt(quantity, 10);
  await docClient.send(
    new UpdateCommand({
      TableName: PRODUCTS_TABLE,
      Key: { productId },
      UpdateExpression: 'SET stock = stock + :qty, updatedAt = :now',
      ExpressionAttributeValues: {
        ':qty': qty,
        ':now': new Date().toISOString()
      }
    })
  );
};

module.exports = {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  softDeleteProduct,
  countActiveProducts,
  seedProducts,
  decrementStock,
  restoreStock,
  VALID_CATEGORIES
};
