import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI } from '../services/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  }, []);

  // Verify token on mount
  useEffect(() => {
    const verifyToken = async () => {
      const savedToken = localStorage.getItem('token');
      if (!savedToken) { setLoading(false); return; }
      try {
        const res = await authAPI.getMe();
        setUser(res.data.user);
      } catch (err) {
        console.warn('Token verification failed, logging out');
        logout();
      } finally {
        setLoading(false);
      }
    };
    verifyToken();
  }, [logout]);

  const login = useCallback(async (credentials) => {
    const res = await authAPI.login(credentials);
    const { token: newToken, user: newUser } = res.data;
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(newUser);
    return newUser;
  }, []);

  const register = useCallback(async (data) => {
    const res = await authAPI.register(data);
    const { token: newToken, user: newUser } = res.data;
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(newUser);
    return newUser;
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
