import React, { useState, useEffect, useCallback } from 'react';
import { productAPI } from '../services/api';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import CartModal from '../components/CartModal';

const CATEGORIES = ['All', 'Electronics', 'Clothing', 'Books', 'Food', 'Furniture', 'Sports', 'Toys', 'Beauty', 'Other'];

const StarRating = ({ rating, count }) => {
  if (!rating) return null;
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    if (i <= Math.floor(rating)) {
      stars.push(<span key={i} className="star star-full">★</span>);
    } else if (i === Math.ceil(rating) && rating % 1 >= 0.25) {
      stars.push(<span key={i} className="star star-half">★</span>);
    } else {
      stars.push(<span key={i} className="star star-empty">★</span>);
    }
  }
  return (
    <div className="product-rating">
      <span className="stars">{stars}</span>
      <span className="rating-value">{rating.toFixed(1)}</span>
      {count != null && <span className="rating-count">({count.toLocaleString()})</span>}
    </div>
  );
};

const SkeletonCard = () => (
  <div className="product-card">
    <div className="skeleton skeleton-img" />
    <div className="product-body">
      <div className="skeleton skeleton-text" style={{ width: '38%' }} />
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-text" style={{ width: '100%' }} />
      <div className="skeleton skeleton-text" style={{ width: '75%' }} />
      <div className="product-footer" style={{ marginTop: 'auto' }}>
        <div className="skeleton skeleton-title" style={{ width: '52px' }} />
        <div className="skeleton skeleton-btn" />
      </div>
    </div>
  </div>
);

const ProductsPage = () => {
  const { addToCart, totalItems } = useCart();
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [cartOpen, setCartOpen] = useState(false);
  const [addedMap, setAddedMap] = useState({});

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (category !== 'All') params.category = category;
      const res = await productAPI.getAll(params);
      let prods = res.data.products || [];
      if (search.trim()) {
        const s = search.toLowerCase();
        prods = prods.filter(p =>
          p.name.toLowerCase().includes(s) || p.description.toLowerCase().includes(s)
        );
      }
      setProducts(prods);
    } catch {
      setError('Failed to load products. Please check that the product service is running.');
    } finally {
      setLoading(false);
    }
  }, [category, search]);

  useEffect(() => {
    const timeout = setTimeout(fetchProducts, 300);
    return () => clearTimeout(timeout);
  }, [fetchProducts]);

  const handleAddToCart = (product) => {
    addToCart(product);
    setAddedMap(prev => ({ ...prev, [product._id]: true }));
    setTimeout(() => setAddedMap(prev => ({ ...prev, [product._id]: false })), 1600);
  };

  return (
    <div className="app-wrapper">
      <div className="main-content">

        {/* Hero */}
        <div className="hero">
          <div className="hero-eyebrow">ShopMesh Store</div>
          <h1 className="hero-title">Everything you need,<br />all in one place.</h1>
          <p className="hero-subtitle">
            Premium products, fast shipping, and seamless checkout.
          </p>
          <div className="hero-actions">
            <button
              className="btn-hero-primary"
              onClick={() => document.getElementById('products-section')?.scrollIntoView({ behavior: 'smooth' })}
            >
              Browse Products
            </button>
            <button className="btn-hero-secondary" onClick={() => setCartOpen(true)}>
              View Cart {totalItems > 0 && <span className="cart-badge">{totalItems}</span>}
            </button>
          </div>
          <div className="hero-stats">
            <div>
              <div className="hero-stat-number">{loading ? '—' : `${products.length}+`}</div>
              <div className="hero-stat-label">Products</div>
            </div>
            <div>
              <div className="hero-stat-number">24/7</div>
              <div className="hero-stat-label">Support</div>
            </div>
            <div>
              <div className="hero-stat-number">99.9%</div>
              <div className="hero-stat-label">Uptime</div>
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <div id="products-section" className="page-header">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
            <div>
              <h2 className="page-title">Discover Products</h2>
              {user?.name && (
                <p className="page-subtitle">Welcome back, <strong>{user.name}</strong></p>
              )}
            </div>
            <button className="btn btn-secondary" onClick={() => setCartOpen(true)} style={{ flexShrink: 0 }}>
              Cart {totalItems > 0 && <span className="cart-badge">{totalItems}</span>}
            </button>
          </div>

          <div className="search-wrap">
            <span className="search-icon">&#x2315;</span>
            <input
              className="search-input"
              type="text"
              placeholder="Search products by name or description..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              id="search-input"
            />
          </div>
        </div>

        <div className="category-pills">
          {CATEGORIES.map(c => (
            <button
              key={c}
              className={`category-pill${category === c ? ' active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {loading ? (
          <div className="products-grid">
            {[1, 2, 3, 4, 5, 6].map(i => <SkeletonCard key={i} />)}
          </div>
        ) : products.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state-icon">&#x26BF;</span>
            <h3>No products found</h3>
            <p>Try a different search term or category.</p>
          </div>
        ) : (
          <div className="products-grid">
            {products.map((product) => {
              const isLimited = product.stock > 0 && product.stock < 10;
              const isOutOfStock = product.stock === 0;
              const hasDiscount = product.originalPrice && product.originalPrice > product.price;
              const discountPct = hasDiscount
                ? Math.round((1 - product.price / product.originalPrice) * 100)
                : 0;

              return (
                <div key={product._id} className="product-card">

                  {/* Badge — one at a time, priority order */}
                  {hasDiscount && (
                    <div className="product-badge badge-sale">-{discountPct}%</div>
                  )}
                  {!hasDiscount && isLimited && (
                    <div className="product-badge badge-limited">Low Stock</div>
                  )}

                  {/* Image */}
                  <div className="product-image-wrap">
                    {product.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="product-image"
                        onError={e => {
                          e.target.style.display = 'none';
                          e.target.parentElement.style.background = 'var(--gray-100)';
                        }}
                      />
                    ) : (
                      <div className="product-image-placeholder">&#x1F4F7;</div>
                    )}
                  </div>

                  <div className="product-body">
                    <div className="product-category">{product.category}</div>
                    <div className="product-name">{product.name}</div>

                    <StarRating rating={product.rating} count={product.reviewCount} />

                    <div className="product-description">{product.description}</div>

                    <div className="product-footer">
                      <div>
                        <div className="product-price-row">
                          <span className="product-price">${product.price.toFixed(2)}</span>
                          {hasDiscount && (
                            <span className="product-price-original">${product.originalPrice.toFixed(2)}</span>
                          )}
                        </div>
                        <div className={`product-stock${isOutOfStock ? ' out' : isLimited ? ' low' : ''}`}>
                          {isOutOfStock
                            ? 'Out of stock'
                            : isLimited
                              ? `Only ${product.stock} left`
                              : `${product.stock} in stock`}
                        </div>
                      </div>
                      <button
                        className={`btn-cart${addedMap[product._id] ? ' added' : ''}`}
                        onClick={() => handleAddToCart(product)}
                        disabled={isOutOfStock}
                        id={`add-cart-${product._id}`}
                      >
                        {addedMap[product._id] ? 'Added' : 'Add to Cart'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {cartOpen && <CartModal onClose={() => setCartOpen(false)} />}
    </div>
  );
};

export default ProductsPage;
