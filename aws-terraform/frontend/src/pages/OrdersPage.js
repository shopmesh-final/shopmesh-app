import React, { useState, useEffect } from 'react';
import { orderAPI } from '../services/api';

const STATUS_CLASSES = {
  pending:   'status-pending',
  confirmed: 'status-confirmed',
  shipped:   'status-shipped',
  delivered: 'status-delivered',
  cancelled: 'status-cancelled',
};

const OrdersPage = () => {
  const [orders, setOrders]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [cancelling, setCancelling] = useState(null);

  const fetchOrders = async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await orderAPI.getMyOrders();
      const data = res.data;
      if      (Array.isArray(data))         setOrders(data);
      else if (Array.isArray(data.orders))  setOrders(data.orders);
      else if (Array.isArray(data.data))    setOrders(data.data);
      else                                  setOrders([]);
    } catch {
      setError('Failed to load orders. Please check that the order service is running.');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchOrders(); }, []);

  const handleCancel = async (orderId) => {
    if (!window.confirm('Cancel this order?')) return;
    setCancelling(orderId);
    try {
      await orderAPI.updateStatus(orderId, 'cancelled');
      setOrders(prev => prev.map(o => o.order_id === orderId ? { ...o, status: 'cancelled' } : o));
    } catch (err) {
      alert(err.response?.data?.detail || 'Failed to cancel order.');
    } finally {
      setCancelling(null);
    }
  };

  const formatDate = (dateStr) =>
    new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  return (
    <div className="main-content">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 className="page-title">Orders</h1>
          <p className="page-subtitle">View and manage your purchase history.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={fetchOrders} id="refresh-orders-btn">
          Refresh
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="orders-list">
          {[1, 2, 3].map(i => (
            <div key={i} className="order-card">
              <div className="order-header">
                <div>
                  <div className="skeleton skeleton-title" style={{ width: '120px', marginBottom: '0.25rem' }} />
                  <div className="skeleton skeleton-text" style={{ width: '150px' }} />
                </div>
                <div className="skeleton" style={{ width: '80px', height: '24px', borderRadius: '9999px' }} />
              </div>
              <div className="skeleton skeleton-text" style={{ width: '100%', marginBottom: '0.5rem' }} />
              <div className="skeleton skeleton-text" style={{ width: '70%' }} />
              <div className="order-total" style={{ marginTop: '1rem' }}>
                <div className="skeleton skeleton-text" style={{ width: '80px', margin: 0 }} />
                <div className="skeleton skeleton-title" style={{ width: '60px', margin: 0 }} />
              </div>
            </div>
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="empty-state">
          <h3>No orders yet</h3>
          <p>When you place an order, it will appear here.</p>
        </div>
      ) : (
        <div className="orders-list">
          {orders.map(order => (
            <div key={order.order_id} className="order-card">
              <div className="order-header">
                <div>
                  <div className="order-id">Order #{order.order_id?.slice(-8).toUpperCase()}</div>
                  <div className="order-date">{formatDate(order.created_at)}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span className={`order-status ${STATUS_CLASSES[order.status] || 'status-pending'}`}>
                    {order.status}
                  </span>
                  {order.status === 'pending' && (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleCancel(order.order_id)}
                      disabled={cancelling === order.order_id}
                    >
                      {cancelling === order.order_id ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                </div>
              </div>

              <div className="order-items">
                {Array.isArray(order.items) && order.items.map((item, idx) => (
                  <div key={idx} className="order-item">
                    <span className="order-item-name">
                      {item.product_name} <span style={{ color: 'var(--gray-500)' }}>×{item.quantity}</span>
                    </span>
                    <span style={{ fontWeight: 500 }}>${Number(item.subtotal || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>

              {order.shipping_address && (
                <div style={{
                  fontSize: '0.875rem', color: 'var(--gray-600)',
                  background: 'var(--gray-50)', border: '1px solid var(--gray-200)',
                  borderRadius: 'var(--r-md)', padding: '0.75rem',
                  marginBottom: '0.5rem',
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--gray-700)', display: 'block', marginBottom: '0.25rem' }}>
                    Shipping Address
                  </span>
                  {order.shipping_address}
                </div>
              )}

              <div className="order-total">
                <span className="order-total-label">Total</span>
                <span className="order-total-amount">${Number(order.total_amount || 0).toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default OrdersPage;
