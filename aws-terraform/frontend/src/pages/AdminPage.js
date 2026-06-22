import React, { useState, useEffect, useCallback } from 'react';
import { analyticsAPI } from '../services/api';

// ── Risk badge ────────────────────────────────────────────────────────────────
const RISK_STYLE = {
  CRITICAL: { background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5' },
  HIGH:     { background: '#fff7ed', color: '#ea580c', border: '1px solid #fdba74' },
  MEDIUM:   { background: '#fefce8', color: '#ca8a04', border: '1px solid #fde047' },
  LOW:      { background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac' },
};

const RiskBadge = ({ level }) => (
  <span style={{
    ...RISK_STYLE[level],
    padding: '2px 10px',
    borderRadius: 4,
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.05em'
  }}>
    {level}
  </span>
);

// ── Trend indicator ───────────────────────────────────────────────────────────
const Trend = ({ pct }) => {
  if (pct > 20)  return <span style={{ color: '#16a34a', fontWeight: 600 }}>↑ +{pct}%</span>;
  if (pct < -20) return <span style={{ color: '#dc2626', fontWeight: 600 }}>↓ {pct}%</span>;
  return <span style={{ color: '#6b7280' }}>→ stable</span>;
};

// ── AI Narrative box ──────────────────────────────────────────────────────────
const AIBox = ({ text, bedrockEnabled }) => (
  <div style={{
    background: 'linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%)',
    border: '1px solid #c7d2fe',
    borderRadius: 10,
    padding: '1.25rem 1.5rem',
    marginBottom: '1.5rem',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: '1.1rem' }}>🤖</span>
      <span style={{ fontWeight: 700, fontSize: '0.875rem', color: '#4338ca' }}>
        {bedrockEnabled ? 'AI Analysis — Amazon Bedrock (Nova Lite)' : 'Analysis Summary'}
      </span>
    </div>
    <p style={{ margin: 0, color: '#1e1b4b', lineHeight: 1.65, fontSize: '0.9rem' }}>{text}</p>
  </div>
);

// ── Inline progress bar ───────────────────────────────────────────────────────
const Bar = ({ pct, color }) => (
  <div style={{ background: '#f3f4f6', borderRadius: 4, height: 8, overflow: 'hidden', minWidth: 80 }}>
    <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} />
  </div>
);

const GENDER_COLOR = { Male: '#3b82f6', Female: '#8b5cf6', Other: '#6b7280', Unknown: '#d1d5db' };
const AGE_COLORS   = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#9ca3af'];

// ── Skeleton loader ───────────────────────────────────────────────────────────
const Skeleton = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    {[1, 2, 3].map(i => (
      <div key={i} style={{
        height: 48, borderRadius: 8,
        background: 'linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%)',
        animation: 'pulse 1.5s ease-in-out infinite'
      }} />
    ))}
  </div>
);

// ────────────────────────────────────────────────────────────────────────────---
// FORECAST TAB
// ────────────────────────────────────────────────────────────────────────────
const ForecastTab = ({ data, loading, error, onRefresh }) => {
  if (loading) return <Skeleton />;
  if (error)   return <div className="alert alert-error">{error}</div>;
  if (!data)   return null;

  const bedrockEnabled = !data.ai_narrative?.includes('No order data') && !data.ai_narrative?.startsWith('CRITICAL') && !data.ai_narrative?.startsWith('Inventory is healthy') && !data.ai_narrative?.startsWith('High priority') && !data.ai_narrative?.startsWith('No');

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <span style={{ fontSize: '0.875rem', color: '#6b7280' }}>
          {data.total_orders_analyzed} orders analyzed · last 28 days
        </span>
        <button className="btn" onClick={onRefresh} style={{ fontSize: '0.8rem', padding: '6px 14px' }}>
          Refresh
        </button>
      </div>

      <AIBox text={data.ai_narrative} bedrockEnabled={true} />

      {data.products.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#9ca3af' }}>
          No product sales data found. Place orders to see forecasts.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                {['Product', 'Stock', 'W1', 'W2', 'W3', 'W4', 'Avg/wk', 'Trend', 'Days Left', 'Risk'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.products.map((p, i) => (
                <tr key={p.product_id} style={{
                  borderBottom: '1px solid #f3f4f6',
                  background: i % 2 === 0 ? '#fff' : '#fafafa'
                }}>
                  <td style={{ padding: '12px', fontWeight: 600, color: '#111827', maxWidth: 200 }}>
                    {p.name}
                  </td>
                  <td style={{ padding: '12px', color: p.current_stock < 5 ? '#dc2626' : '#374151', fontWeight: p.current_stock < 5 ? 700 : 400 }}>
                    {p.current_stock}
                  </td>
                  {p.weekly_sales.map((w, wi) => (
                    <td key={wi} style={{ padding: '12px', color: '#4b5563', textAlign: 'center' }}>{w}</td>
                  ))}
                  <td style={{ padding: '12px', textAlign: 'center', fontWeight: 600 }}>{p.avg_weekly_sales}</td>
                  <td style={{ padding: '12px' }}><Trend pct={p.trend_pct} /></td>
                  <td style={{ padding: '12px', color: '#374151' }}>
                    {p.days_until_stockout != null ? `${p.days_until_stockout}d` : '—'}
                  </td>
                  <td style={{ padding: '12px' }}><RiskBadge level={p.risk_level} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// DEMOGRAPHICS TAB
// ────────────────────────────────────────────────────────────────────────────
const DemographicsTab = ({ data, loading, error, onRefresh }) => {
  if (loading) return <Skeleton />;
  if (error)   return <div className="alert alert-error">{error}</div>;
  if (!data)   return null;

  const { summary } = data;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <span style={{ fontSize: '0.875rem', color: '#6b7280' }}>
          {data.total_orders_analyzed} orders · {data.total_users_with_demographics} users with demographic data
        </span>
        <button className="btn" onClick={onRefresh} style={{ fontSize: '0.8rem', padding: '6px 14px' }}>
          Refresh
        </button>
      </div>

      <AIBox text={data.ai_narrative} bedrockEnabled={false} />

      {/* Overall Summary Cards */}
      {(Object.keys(summary.gender_totals).length > 0 || Object.keys(summary.age_group_totals).length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
          {/* Gender totals */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '1.25rem' }}>
            <div style={{ fontWeight: 700, marginBottom: '0.75rem', color: '#111827', fontSize: '0.875rem' }}>
              Overall Gender Breakdown
            </div>
            {Object.entries(summary.gender_totals)
              .sort((a, b) => b[1] - a[1])
              .map(([g, units]) => {
                const total = Object.values(summary.gender_totals).reduce((a, b) => a + b, 0);
                const pct = total ? Math.round((units / total) * 100) : 0;
                return (
                  <div key={g} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: '0.8rem' }}>
                      <span style={{ color: GENDER_COLOR[g] || '#6b7280', fontWeight: 600 }}>{g}</span>
                      <span style={{ color: '#6b7280' }}>{units} units ({pct}%)</span>
                    </div>
                    <Bar pct={pct} color={GENDER_COLOR[g] || '#9ca3af'} />
                  </div>
                );
              })}
          </div>

          {/* Age group totals */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '1.25rem' }}>
            <div style={{ fontWeight: 700, marginBottom: '0.75rem', color: '#111827', fontSize: '0.875rem' }}>
              Overall Age Group Breakdown
            </div>
            {Object.entries(summary.age_group_totals)
              .filter(([ag]) => ag !== 'Unknown')
              .sort((a, b) => b[1] - a[1])
              .map(([ag, units], idx) => {
                const total = Object.values(summary.age_group_totals).reduce((a, b) => a + b, 0);
                const pct = total ? Math.round((units / total) * 100) : 0;
                return (
                  <div key={ag} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: '0.8rem' }}>
                      <span style={{ color: AGE_COLORS[idx % AGE_COLORS.length], fontWeight: 600 }}>{ag}</span>
                      <span style={{ color: '#6b7280' }}>{units} units ({pct}%)</span>
                    </div>
                    <Bar pct={pct} color={AGE_COLORS[idx % AGE_COLORS.length]} />
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Per-product breakdown */}
      {data.products.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#9ca3af' }}>
          No order data found. Place orders to see demographic analytics.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {data.products.map(p => (
            <div key={p.product_id} style={{
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              padding: '1.25rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <span style={{ fontWeight: 700, color: '#111827' }}>{p.name}</span>
                <span style={{ fontSize: '0.8rem', background: '#f3f4f6', padding: '3px 10px', borderRadius: 20, color: '#374151', fontWeight: 600 }}>
                  {p.total_units_sold} units sold
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                {/* Gender */}
                <div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    By Gender
                  </div>
                  {Object.keys(p.gender_breakdown).length === 0 ? (
                    <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>No data</span>
                  ) : (
                    Object.entries(p.gender_breakdown)
                      .sort((a, b) => b[1].units - a[1].units)
                      .map(([g, v]) => (
                        <div key={g} style={{ marginBottom: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: '0.8rem' }}>
                            <span style={{ color: GENDER_COLOR[g] || '#6b7280', fontWeight: 600 }}>{g}</span>
                            <span style={{ color: '#6b7280' }}>{v.units} ({v.pct}%)</span>
                          </div>
                          <Bar pct={v.pct} color={GENDER_COLOR[g] || '#9ca3af'} />
                        </div>
                      ))
                  )}
                </div>

                {/* Age */}
                <div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    By Age Group
                  </div>
                  {Object.keys(p.age_breakdown).filter(ag => ag !== 'Unknown').length === 0 ? (
                    <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>No age data yet</span>
                  ) : (
                    Object.entries(p.age_breakdown)
                      .filter(([ag]) => ag !== 'Unknown')
                      .sort((a, b) => b[1].units - a[1].units)
                      .map(([ag, v], idx) => (
                        <div key={ag} style={{ marginBottom: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: '0.8rem' }}>
                            <span style={{ color: AGE_COLORS[idx % AGE_COLORS.length], fontWeight: 600 }}>{ag}</span>
                            <span style={{ color: '#6b7280' }}>{v.units} ({v.pct}%)</span>
                          </div>
                          <Bar pct={v.pct} color={AGE_COLORS[idx % AGE_COLORS.length]} />
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// MAIN ADMIN PAGE
// ────────────────────────────────────────────────────────────────────────────
const AdminPage = () => {
  const [activeTab, setActiveTab] = useState('forecast');
  const [forecastData, setForecastData] = useState(null);
  const [demoData, setDemoData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadForecast = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await analyticsAPI.getInventoryForecast();
      setForecastData(res.data);
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to load inventory forecast. Is the analytics service running?');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDemographics = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await analyticsAPI.getDemographics();
      setDemoData(res.data);
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to load demographics. Is the analytics service running?');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'forecast' && !forecastData) loadForecast();
    if (activeTab === 'demographics' && !demoData) loadDemographics();
  }, [activeTab, forecastData, demoData, loadForecast, loadDemographics]);

  const switchTab = (tab) => {
    setActiveTab(tab);
    setError('');
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '2rem 1.5rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: '#111827', margin: 0 }}>
          Admin Dashboard
        </h1>
        <p style={{ color: '#6b7280', marginTop: 6, marginBottom: 0 }}>
          AI-powered inventory forecasting and demographic analytics
        </p>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: '1.5rem' }}>
        <button
          className={`tab ${activeTab === 'forecast' ? 'active' : ''}`}
          onClick={() => switchTab('forecast')}
        >
          📦 Inventory Forecast
        </button>
        <button
          className={`tab ${activeTab === 'demographics' ? 'active' : ''}`}
          onClick={() => switchTab('demographics')}
        >
          👥 Demographics
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'forecast' && (
        <ForecastTab
          data={forecastData}
          loading={loading}
          error={error}
          onRefresh={loadForecast}
        />
      )}
      {activeTab === 'demographics' && (
        <DemographicsTab
          data={demoData}
          loading={loading}
          error={error}
          onRefresh={loadDemographics}
        />
      )}
    </div>
  );
};

export default AdminPage;
