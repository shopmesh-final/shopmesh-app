import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';

const AuthPage = () => {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [form, setForm] = useState({ name: '', email: '', password: '', gender: '', age: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (mode === 'login') {
        await login({ email: form.email, password: form.password });
      } else {
        if (!form.name.trim()) { setError('Name is required'); setLoading(false); return; }
        if (form.password.length < 6) { setError('Password must be at least 6 characters'); setLoading(false); return; }
        if (!form.gender) { setError('Gender is required'); setLoading(false); return; }
        const age = parseInt(form.age, 10);
        if (!form.age || isNaN(age)) { setError('Age is required'); setLoading(false); return; }
        if (age < 13 || age > 100) { setError('Age must be between 13 and 100'); setLoading(false); return; }
        await register({ name: form.name, email: form.email, password: form.password, gender: form.gender, age });
      }
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        err.response?.data?.errors?.[0]?.msg ||
        'An error occurred. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (newMode) => {
    setMode(newMode);
    setError('');
    setForm({ name: '', email: '', password: '', gender: '', age: '' });
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="auth-logo-dot" />
          ShopMesh
        </div>
        <p className="auth-subtitle">
          {mode === 'login' ? 'Sign in to your account to continue' : 'Create an account to get started'}
        </p>

        {/* Tabs */}
        <div className="tabs" style={{ marginBottom: '1.5rem' }}>
          <button className={`tab ${mode === 'login' ? 'active' : ''}`} onClick={() => switchMode('login')}>Sign In</button>
          <button className={`tab ${mode === 'register' ? 'active' : ''}`} onClick={() => switchMode('register')}>Register</button>
        </div>

        {error && (
          <div className="alert alert-error">
            <span style={{ fontWeight: 600 }}>!</span> {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {mode === 'register' && (
            <div className="form-group">
              <label className="form-label" htmlFor="name">Full Name</label>
              <input
                id="name" name="name" type="text"
                className="form-input" placeholder="John Doe"
                value={form.name} onChange={handleChange} required
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="email">Email Address</label>
            <input
              id="email" name="email" type="email"
              className="form-input" placeholder="you@example.com"
              value={form.email} onChange={handleChange} required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="password">Password</label>
            <input
              id="password" name="password" type="password"
              className="form-input"
              placeholder={mode === 'register' ? 'At least 6 characters' : '••••••••'}
              value={form.password} onChange={handleChange} required
            />
          </div>

          {mode === 'register' && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="gender">Gender</label>
                <select
                  id="gender" name="gender"
                  className="form-input"
                  style={{ cursor: 'pointer' }}
                  value={form.gender} onChange={handleChange} required
                >
                  <option value="">Select gender</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="age">Age</label>
                <input
                  id="age" name="age" type="number"
                  className="form-input"
                  placeholder="Your age (13–100)"
                  value={form.age} onChange={handleChange}
                  min="13" max="100" required
                />
              </div>
            </>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading}
            style={{ marginTop: '0.5rem', padding: '0.75rem' }}
          >
            {loading ? (
              <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Processing...</>
            ) : (
              mode === 'login' ? 'Sign In' : 'Create Account'
            )}
          </button>
        </form>

        <div className="auth-toggle">
          {mode === 'login'
            ? <>Don't have an account? <a href="/" onClick={(e) => { e.preventDefault(); switchMode('register'); }}>Register</a></>
            : <>Already have an account? <a href="/" onClick={(e) => { e.preventDefault(); switchMode('login'); }}>Sign In</a></>
          }
        </div>
      </div>
    </div>
  );
};

export default AuthPage;
