import React, { createContext, useContext, useState, useCallback } from 'react';

const CartContext = createContext(null);

export const CartProvider = ({ children }) => {
  const [items, setItems] = useState([]);

  const addToCart = useCallback((product) => {
    const id = product.productId || product._id;
    const incomingQty = (product.quantity && product.quantity > 0) ? product.quantity : 1;
    const normalized = { ...product, _id: id };
    setItems(prev => {
      const existing = prev.find(i => i._id === id);
      if (existing) {
        return prev.map(i => i._id === id ? { ...i, quantity: i.quantity + incomingQty } : i);
      }
      return [...prev, { ...normalized, quantity: incomingQty }];
    });
  }, []);

  const removeFromCart = useCallback((productId) => {
    setItems(prev => prev.filter(i => i._id !== productId));
  }, []);

  const updateQuantity = useCallback((productId, qty) => {
    if (qty <= 0) {
      setItems(prev => prev.filter(i => i._id !== productId));
    } else {
      setItems(prev => prev.map(i => i._id === productId ? { ...i, quantity: qty } : i));
    }
  }, []);

  const clearCart = useCallback(() => setItems([]), []);

  const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
  const totalAmount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

  return (
    <CartContext.Provider value={{ items, addToCart, removeFromCart, updateQuantity, clearCart, totalItems, totalAmount }}>
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
};
