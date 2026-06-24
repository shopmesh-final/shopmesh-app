import React, { useState } from 'react';
import { useCart } from '../context/CartContext';
import { orderAPI } from '../services/api';

const STEP_LABELS = { cart: 'Cart', checkout: 'Checkout', success: 'Complete' };
const STEP_ORDER = ['cart', 'checkout', 'success'];

const StepIndicator = ({ current }) => {
  const currentIdx = STEP_ORDER.indexOf(current);
  return (
    <div className="checkout-steps">
      {STEP_ORDER.map((s, i) => {
        const isDone    = i < currentIdx;
        const isActive  = i === currentIdx;
        return (
          <div key={s} className={`step-item${isActive ? ' active' : isDone ? ' done' : ''}`}>
            <div className="step-circle">{isDone ? '✓' : i + 1}</div>
            <div className="step-label">{STEP_LABELS[s]}</div>
          </div>
        );
      })}
    </div>
  );
};

const CartModal = ({ onClose }) => {
  const { items, removeFromCart, updateQuantity, clearCart, totalAmount } = useCart();
  const [step, setStep]       = useState('cart');
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [orderId, setOrderId] = useState(null);

  const TITLES = { cart: 'Shopping Cart', checkout: 'Checkout', success: 'Order Confirmed' };

  const handlePlaceOrder = async () => {
    if (!address.trim() || address.trim().length < 5) {
      setError('Please enter a valid shipping address (at least 5 characters).');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await orderAPI.create({
        items: items.map(i => ({ product_id: i._id, quantity: i.quantity })),
        shipping_address: address.trim(),
      });
      setOrderId(res.data.order_id);
      clearCart();
      setStep('success');
    } catch (err) {
      const detail = err.response?.data?.detail || err.response?.data?.error || 'Failed to place order. Please try again.';
      setError(typeof detail === 'string' ? detail : JSON.stringify(detail));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">

        <div className="modal-header">
          <h2 className="modal-title">{TITLES[step]}</h2>
          <button className="modal-close" onClick={onClose} id="close-cart-btn" aria-label="Close">&#x2715;</button>
        </div>

        {step !== 'success' && <StepIndicator current={step} />}

        {/* ── CART ── */}
        {step === 'cart' && (
          items.length === 0 ? (
            <div className="empty-state">
              <h3>Your cart is empty</h3>
              <p>Browse products and add items to get started.</p>
            </div>
          ) : (
            <>
              <div className="cart-list">
                {items.map(item => (
                  <div key={item._id} className="cart-item">
                    <div className="cart-item-info">
                      <div className="cart-item-name">{item.name}</div>
                      <div className="cart-item-price">${item.price.toFixed(2)} each</div>
                    </div>
                    <div className="qty-control">
                      <button
                        className="qty-btn"
                        onClick={() => updateQuantity(item._id, item.quantity - 1)}
                        disabled={item.quantity <= 1}
                      >−</button>
                      <span className="qty-value">{item.quantity}</span>
                      <button
                        className="qty-btn"
                        onClick={() => updateQuantity(item._id, item.quantity + 1)}
                        disabled={item.quantity >= item.stock}
                      >+</button>
                    </div>
                    <div className="cart-item-total">${(item.price * item.quantity).toFixed(2)}</div>
                    <button
                      className="cart-remove-btn"
                      onClick={() => removeFromCart(item._id)}
                      title="Remove"
                    >&#x2715;</button>
                  </div>
                ))}
              </div>

              <div className="cart-subtotal">
                <span className="cart-subtotal-label">Subtotal</span>
                <span className="cart-subtotal-value">${totalAmount.toFixed(2)}</span>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button className="btn btn-secondary" onClick={clearCart} id="clear-cart-btn" style={{ flex: 1 }}>
                  Clear Cart
                </button>
                <button className="btn btn-primary" onClick={() => setStep('checkout')} id="proceed-checkout-btn" style={{ flex: 2 }}>
                  Checkout
                </button>
              </div>
            </>
          )
        )}

        {/* ── CHECKOUT ── */}
        {step === 'checkout' && (
          <>
            <div className="order-summary-card">
              <div className="order-summary-title">Order Summary</div>
              {items.map(item => (
                <div key={item._id} className="order-summary-row">
                  <span>{item.name} <span style={{ color: 'var(--gray-500)', fontWeight: 400 }}>×{item.quantity}</span></span>
                  <strong>${(item.price * item.quantity).toFixed(2)}</strong>
                </div>
              ))}
              <div className="order-summary-total">
                <span>Total Due</span>
                <span>${totalAmount.toFixed(2)}</span>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="shipping-address">Shipping Address</label>
              <textarea
                id="shipping-address"
                className="form-textarea"
                placeholder="123 Main St, City, State, ZIP"
                value={address}
                onChange={e => { setAddress(e.target.value); setError(''); }}
                rows={3}
              />
            </div>

            {error && <div className="alert alert-error">{error}</div>}

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button className="btn btn-secondary" onClick={() => setStep('cart')} style={{ flex: 1 }}>
                Back
              </button>
              <button
                className="btn btn-primary"
                onClick={handlePlaceOrder}
                disabled={loading}
                id="place-order-btn"
                style={{ flex: 2 }}
              >
                {loading ? (
                  <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2, marginRight: 8 }} />Processing...</>
                ) : 'Place Order'}
              </button>
            </div>
          </>
        )}

        {/* ── SUCCESS ── */}
        {step === 'success' && (
          <div style={{ textAlign: 'center', padding: '0.5rem 0 1rem' }}>
            <div className="success-icon">&#x2713;</div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--gray-900)', marginBottom: '0.5rem' }}>
              Your order is confirmed
            </h3>
            <p style={{ color: 'var(--gray-600)', fontSize: '0.9375rem', lineHeight: 1.6 }}>
              We'll send you updates at each stage of your delivery.
            </p>
            {orderId && (
              <div className="order-ref-box">
                <div className="order-ref-label">Order ID</div>
                <div className="order-ref-value">{orderId.slice(-8).toUpperCase()}</div>
              </div>
            )}
            <button className="btn btn-primary btn-full" onClick={onClose} id="order-success-close-btn">
              Continue Shopping
            </button>
          </div>
        )}

      </div>
    </div>
  );
};

export default CartModal;
