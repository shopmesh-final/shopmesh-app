import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';

const Navbar = () => {
  const { user, logout } = useAuth();
  const { totalItems } = useCart();

  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  };

  return (
    <nav className="navbar" role="navigation">
      <NavLink to="/" className="navbar-brand">
        <span className="navbar-brand-dot" />
        ShopMesh
      </NavLink>

      <div className="navbar-links">
        <NavLink to="/products" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} id="nav-products">
          Products
        </NavLink>
        <NavLink to="/orders" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} id="nav-orders">
          Orders {totalItems > 0 && <span className="cart-badge">{totalItems}</span>}
        </NavLink>
        {user?.role === 'admin' && (
          <NavLink to="/admin" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} id="nav-admin">
            Admin
          </NavLink>
        )}
      </div>

      {user && (
        <div className="nav-user">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.3 }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gray-900)' }}>{user.name}</span>
            <span style={{ fontSize: '0.75rem', color: user.role === 'admin' ? '#6366f1' : 'var(--gray-500)', fontWeight: user.role === 'admin' ? 700 : 400 }}>
              {user.role === 'admin' ? 'Admin' : 'Customer'}
            </span>
          </div>
          <div className="nav-avatar" title={user.name}>{getInitials(user.name)}</div>
          <div className="nav-divider" />
          <button className="btn-logout" onClick={logout} id="logout-btn">Log out</button>
        </div>
      )}
    </nav>
  );
};

export default Navbar;
