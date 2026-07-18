import { useState, useMemo, useEffect } from 'react';

// Define all route categories with their details
const ROUTE_CATEGORIES = [
  {
    id: 'analytics',
    name: 'Analytics',
    color: '#8b5cf6',
    routes: [
      { path: '/analytics/cycles', label: 'Cycle Summaries', description: 'View cycle summaries' },
      { path: '/analytics/agents', label: 'Agent Analytics', description: 'View agent analytics' },
      { path: '/analytics/provider-breakdown', label: 'Provider Breakdown', description: 'View provider usage breakdown' },
      { path: '/performance', label: 'Overall Performance', description: 'View overall performance' },
      { path: '/performance/history', label: 'Historical Performance', description: 'View historical performance' },
      { path: '/analytics/cycle/:cycle_num', label: 'Single Cycle Detail', description: 'View single cycle detail' },
      { path: '/analytics/agent/:agent_name', label: 'Single Agent Analytics', description: 'View single agent analytics' },
      { path: '/analytics/llm-calls', label: 'LLM Call Log', description: 'View LLM call log' },
    ]
  },
  {
    id: 'trading',
    name: 'Trading & Pipeline',
    color: '#3b82f6',
    routes: [
      { path: '/mode', label: 'Current Mode', description: 'Get current mode' },
      { path: '/mode/:mode', label: 'Set Mode', description: 'Set trading mode' },
      { path: '/simulation/start', label: 'Start Simulation', description: 'Start simulation' },
      { path: '/simulation/stop', label: 'Stop Simulation', description: 'Stop simulation' },
      { path: '/flow/summary', label: 'Pipeline Summary', description: 'View pipeline flow summary' },
      { path: '/flow/state', label: 'Pipeline State', description: 'View current pipeline state' },
    ]
  },
  {
    id: 'agents',
    name: 'Agents',
    color: 'var(--text-primary)',
    routes: [
      { path: '/agents', label: 'All Agent States', description: 'View all agent states' },
      { path: '/agents/:agent_name/action', label: 'Trigger Agent Action', description: 'Trigger agent action' },
      { path: '/agents/:agent_name/marketview', label: 'Agent Market View', description: 'View agent\'s market view' },
      { path: '/agents/flow/:agent_name', label: 'Agent Flow Data', description: 'View agent flow data' },
    ]
  },
  {
    id: 'portfolio',
    name: 'Portfolio & Market',
    color: 'var(--text-primary)',
    routes: [
      { path: '/portfolio', label: 'Portfolio State', description: 'View portfolio state' },
      { path: '/market-data/:symbol', label: 'Market Data', description: 'View market data for symbol' },
      { path: '/spy-benchmark', label: 'SPY Benchmark', description: 'View SPY benchmark comparison' },
    ]
  },
  {
    id: 'oracle',
    name: 'Oracle',
    color: 'var(--text-secondary)',
    routes: [
      { path: '/oracle/performance', label: 'Oracle Performance', description: 'View oracle performance metrics' },
      { path: '/oracle/trigger-analysis/:symbol', label: 'Trigger Analysis', description: 'Trigger oracle analysis' },
    ]
  },
  {
    id: 'scout',
    name: 'Scout',
    color: '#D35400',
    routes: [
      { path: '/scout/opportunities', label: 'Opportunities', description: 'View discovered opportunities' },
      { path: '/scout/stats', label: 'Scout Statistics', description: 'View scout statistics' },
      { path: '/scout/propose-ticker', label: 'Propose Ticker', description: 'Propose a ticker' },
      { path: '/scout/add-ticker/:symbol', label: 'Add Ticker to Queue', description: 'Add ticker to queue' },
    ]
  },
  {
    id: 'collaboration',
    name: 'Collaboration',
    color: '#ec4899',
    routes: [
      { path: '/collaborate/initiate', label: 'Initiate Session', description: 'Start collaboration session' },
      { path: '/collaborate/vote', label: 'Cast Vote', description: 'Cast vote' },
      { path: '/collaborate/active', label: 'Active Sessions', description: 'View active sessions' },
      { path: '/collaborate/stats', label: 'Collaboration Stats', description: 'View collaboration stats' },
      { path: '/collaborate/dialogue/:agent_name', label: 'Agent Dialogue', description: 'View agent dialogue' },
    ]
  },
  {
    id: 'logs',
    name: 'Logs',
    color: 'var(--text-muted)',
    routes: [
      { path: '/logs/trades', label: 'Trade Log', description: 'View trade log' },
      { path: '/logs/agent/:agent_name', label: 'Agent Log', description: 'View agent-specific log' },
      { path: '/logs/activities', label: 'Activity Feed', description: 'View activity feed' },
      { path: '/logs/data-fetches', label: 'Data Fetch Log', description: 'View data fetch log' },
      { path: '/logs/system', label: 'System Log', description: 'View system log' },
      { path: '/logs/statistics', label: 'Log Statistics', description: 'View log stats' },
      { path: '/logs/export', label: 'Export Logs', description: 'Export logs' },
    ]
  },
  {
    id: 'state',
    name: 'State Management',
    color: '#6366f1',
    routes: [
      { path: '/state', label: 'Full State', description: 'View full state' },
      { path: '/state/save', label: 'Save State', description: 'Save state' },
      { path: '/state/load', label: 'Load State', description: 'Load saved state' },
      { path: '/state/backups', label: 'List Backups', description: 'List backups' },
      { path: '/state/restore/:filename', label: 'Restore Backup', description: 'Restore backup' },
      { path: '/state/status', label: 'State Status', description: 'View state status' },
    ]
  },
  {
    id: 'manual',
    name: 'Manual Analysis',
    color: '#14b8a6',
    routes: [
      { path: '/manual/analyze/:ticker', label: 'AI Analysis', description: 'Run full AI analysis' },
      { path: '/manual/status/:analysis_id', label: 'Analysis Progress', description: 'Check analysis progress' },
      { path: '/manual/recent', label: 'Recent Analyses', description: 'View recent analyses' },
    ]
  },
  {
    id: 'providers',
    name: 'LLM Providers',
    color: '#f97316',
    routes: [
      { path: '/api/provider-config', label: 'Provider Config', description: 'View provider configuration' },
      { path: '/api/provider-stats', label: 'Provider Stats', description: 'View provider stats' },
      { path: '/api/test-provider', label: 'Test Provider', description: 'Test a provider' },
      { path: '/api/test-provider-real', label: 'Real Provider Test', description: 'Test real provider' },
    ]
  }
];

// Common routes for quick access
const COMMON_ROUTES = [
  { path: '/mode', label: 'Trading Mode', category: 'trading', color: '#3b82f6' },
  { path: '/agents', label: 'Agent States', category: 'agents', color: 'var(--text-primary)' },
  { path: '/portfolio', label: 'Portfolio', category: 'portfolio', color: 'var(--text-primary)' },
  { path: '/analytics/cycles', label: 'Analytics', category: 'analytics', color: '#8b5cf6' },
  { path: '/scout/opportunities', label: 'Scout', category: 'scout', color: '#D35400' },
  { path: '/logs/trades', label: 'Trade Logs', category: 'logs', color: 'var(--text-muted)' },
];

// Base URL for API calls
const BASE_URL = '';

// Function to check endpoint status
async function checkEndpointStatus(path) {
  try {
    // Skip WebSocket endpoints
    if (path.includes('ws/')) {
      return { status: 'N/A', message: 'WebSocket' };
    }
    
    // Handle dynamic routes by replacing placeholders
    const cleanPath = path.replace(/:[^/]+/g, 'test');
    const fullPath = `/trading-floor${cleanPath}`;
    
    const response = await fetch(fullPath, { method: 'GET', cache: 'no-cache' });
    
    if (response.ok || response.status === 405) { // 405 means endpoint exists but wrong method
      return { status: 'online', message: `Status: ${response.status}` };
    } else {
      return { status: 'offline', message: `Error: ${response.status}` };
    }
  } catch (error) {
    return { status: 'offline', message: 'Network error' };
  }
}

function RouteCard({ route, color, onNavigate, endpointStatus }) {
  const statusInfo = endpointStatus[route.path];
  
  return (
    <div 
      className="dashboard-route-card" 
      style={{ borderColor: color + '40', background: color + '05' }}
      onClick={() => onNavigate(route.path)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontWeight: 600, color, fontSize: 13 }}>{route.label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{route.path}</div>
          {statusInfo && (
            <div 
              className="endpoint-status"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: statusInfo.status === 'online' ? '#22c55e' : statusInfo.status === 'offline' ? '#ef4444' : '#f59e0b',
                title: statusInfo.message
              }}
            />
          )}
        </div>
      </div>
      <div className="dashboard-route-desc" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {route.description}
      </div>
    </div>
  );
}

function CategorySection({ category, routes, onNavigate, isOpen, onToggle, endpointStatus }) {
  return (
    <div className="dashboard-category-section">
      <div 
        className="dashboard-category-header" 
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div 
            className="dashboard-category-dot" 
            style={{ background: category.color }}
          />
          <div style={{ fontWeight: 700, fontSize: 14 }}>{category.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>({routes.length})</div>
        </div>
        <div style={{ fontSize: 12 }}>{isOpen ? '▲' : '▼'}</div>
      </div>
      
      {isOpen && (
        <div className="dashboard-category-content">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
            {routes.map((route, idx) => (
              <RouteCard 
                key={idx} 
                route={route} 
                color={category.color} 
                onNavigate={onNavigate} 
                endpointStatus={endpointStatus}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DashboardPage({}) {
  const [openCategories, setOpenCategories] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [endpointStatus, setEndpointStatus] = useState({});
  const [checkingStatus, setCheckingStatus] = useState(false);
  
  // Toggle category open/close
  const toggleCategory = (categoryId) => {
    setOpenCategories(prev => ({
      ...prev,
      [categoryId]: !prev[categoryId]
    }));
  };
  
  // Navigate to a route
  const navigateToRoute = (path) => {
    // Handle WebSocket routes
    if (path.includes('ws/')) {
      alert(`Cannot navigate directly to WebSocket endpoint: ${path}`);
      return;
    }
    
    // For frontend routes, change the hash
    if (path.startsWith('/')) {
      // Convert API paths to frontend routes
      let route = path;
      
      // Map API routes to frontend routes
      if (path.includes('/mode') || path.includes('/simulation')) {
        route = '/flow';
      } else if (path.includes('/agents')) {
        route = '/flow';
      } else if (path.includes('/portfolio')) {
        route = '/flow';
      } else if (path.includes('/analytics') || path.includes('/performance')) {
        route = '/monitor';
      } else if (path.includes('/scout')) {
        route = '/flow';
      } else if (path.includes('/oracle')) {
        route = '/flow';
      } else if (path.includes('/logs')) {
        route = '/monitor';
      } else if (path.includes('/manual')) {
        route = '/analyze';
      } else if (path.includes('/collaborate')) {
        route = '/flow';
      } else if (path.includes('/state')) {
        route = '/monitor';
      } else if (path.includes('/api/provider')) {
        route = '/monitor';
      }
      
      window.location.hash = `#${route}`;
    } else {
      window.open(path, '_blank');
    }
  };
  
  // Check status of all endpoints
  const checkAllEndpoints = async () => {
    setCheckingStatus(true);
    const newStatus = {};
    
    // Collect all unique routes
    const allRoutes = [];
    ROUTE_CATEGORIES.forEach(category => {
      category.routes.forEach(route => {
        if (!allRoutes.some(r => r.path === route.path)) {
          allRoutes.push(route);
        }
      });
    });
    
    // Check each route
    for (const route of allRoutes) {
      newStatus[route.path] = await checkEndpointStatus(route.path);
    }
    
    setEndpointStatus(newStatus);
    setCheckingStatus(false);
  };
  
  // Initialize all categories as open by default
  useEffect(() => {
    if (Object.keys(openCategories).length === 0) {
      const initialOpen = {};
      ROUTE_CATEGORIES.forEach(cat => {
        initialOpen[cat.id] = true;
      });
      setOpenCategories(initialOpen);
    }
    
    // Check endpoint status on initial load
    checkAllEndpoints();
  }, []);
  
  // Filter routes based on search term
  const filteredCategories = useMemo(() => {
    if (!searchTerm) {
      return ROUTE_CATEGORIES;
    }
    
    const term = searchTerm.toLowerCase();
    return ROUTE_CATEGORIES.map(category => ({
      ...category,
      routes: category.routes.filter(route => 
        route.path.toLowerCase().includes(term) ||
        route.label.toLowerCase().includes(term) ||
        route.description.toLowerCase().includes(term)
      )
    })).filter(category => category.routes.length > 0);
  }, [searchTerm]);

  return (
    <div className="dashboard-page">
      {/* Header */}
      <div className="dashboard-header">
        <div className="dashboard-title">Main Dashboard</div>
        <div className="dashboard-subtitle">Easy Access to All Routes</div>
        <div style={{ marginTop: 10 }}>
          <button 
            className="dashboard-status-btn"
            onClick={checkAllEndpoints}
            disabled={checkingStatus}
            style={{
              padding: '6px 12px',
              background: checkingStatus ? '#64748b' : '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              fontSize: '12px',
              cursor: checkingStatus ? 'wait' : 'pointer'
            }}
          >
            {checkingStatus ? 'Checking...' : 'Refresh Status'}
          </button>
        </div>
      </div>
      
      {/* Search Bar */}
      <div className="dashboard-search-container">
        <input
          type="text"
          placeholder="Search routes by name, path, or description..."
          className="dashboard-search-input"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>
      
      {/* Quick Access */}
      <div className="dashboard-quick-access">
        <div className="dashboard-quick-header">
          <div className="dashboard-quick-dot" style={{ background: '#3b82f6' }} />
          <div>Quick Access</div>
        </div>
        <div className="dashboard-quick-content">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            {COMMON_ROUTES.map((route, idx) => (
              <div
                key={idx}
                className="dashboard-quick-card"
                style={{ borderColor: route.color + '40', background: route.color + '10' }}
                onClick={() => navigateToRoute(route.path)}
              >
                <div style={{ fontWeight: 600, color: route.color, fontSize: 12 }}>{route.label}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{route.category}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {/* Route Categories */}
      {filteredCategories.map((category) => (
        <CategorySection
          key={category.id}
          category={category}
          routes={category.routes}
          onNavigate={navigateToRoute}
          isOpen={openCategories[category.id]}
          onToggle={() => toggleCategory(category.id)}
          endpointStatus={endpointStatus}
        />
      ))}
      
      {searchTerm && filteredCategories.length === 0 && (
        <div className="dashboard-no-results">
          No routes found matching "{searchTerm}"
        </div>
      )}
    </div>
  );
}