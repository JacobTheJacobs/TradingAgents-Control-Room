const BASE = '/trading-floor'

async function fetchJSON(path) {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export const fetchOraclePerformance = () => fetchJSON('/oracle/performance')
export const fetchLearningInsights = () => fetchJSON('/performance')
export const fetchTradeMemory = () => fetchJSON('/state/status')
export const fetchProviderStats = () => fetchJSON('/api/provider-stats')
export const fetchPerformanceHistory = () => fetchJSON('/performance/history')
export const fetchFlowSummary = () => fetchJSON('/flow/summary')
export const fetchLogStatistics = () => fetchJSON('/logs/statistics')
export const fetchFlowState = () => fetchJSON('/flow/state')
export const fetchPortfolio = () => fetchJSON('/portfolio')
export const fetchAgents = () => fetchJSON('/agents')
export const fetchScoutStats = () => fetchJSON('/scout/stats')
export const fetchScoutOpportunities = () => fetchJSON('/scout/opportunities')
export const fetchTradeLogs = () => fetchJSON('/logs/trades')
export const fetchSystemLogs = () => fetchJSON('/logs/system')
export const fetchActivities = () => fetchJSON('/logs/activities')
export const fetchState = () => fetchJSON('/state')
export const fetchAgentFlow = (name) => fetchJSON(`/agents/flow/${name}`)
export const fetchSpyBenchmark = () => fetchJSON('/spy-benchmark')
export const fetchClosedTrades = (limit = 0) => fetchJSON(`/closed-trades?limit=${limit}`)
export const fetchAnalyticsCycles = () => fetchJSON('/analytics/cycles')
export const fetchAnalyticsProviders = () => fetchJSON('/analytics/provider-breakdown')
export const fetchAnalyticsAgents = () => fetchJSON('/analytics/agents')

// Manual analysis
export async function postManualAnalysis(ticker) {
  const res = await fetch(BASE + `/manual/analyze/${ticker}`, { method: 'POST' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}
export const fetchManualStatus = (id) => fetchJSON(`/manual/status/${id}`)
export const fetchManualRecent = () => fetchJSON('/manual/recent')

// Mode control
export const fetchMode = () => fetchJSON('/mode')
export async function setMode(mode) {
  const res = await fetch(BASE + `/mode/${mode}`, { method: 'POST' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

// LLM Control Center
async function putJSON(path, body) {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

async function postJSON(path, body = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export const fetchLLMConfig    = () => fetchJSON('/llm/config')
export const fetchLLMProviders = () => fetchJSON('/llm/providers')
export const fetchLLMPhases    = () => fetchJSON('/llm/phases')
export const fetchLLMAgents    = () => fetchJSON('/llm/agents')
export const fetchLLMUsage     = () => fetchJSON('/llm/usage')

export const updateLLMConfig   = (config) => putJSON('/llm/config', config)
export const updateLLMPhase    = (name, config) => putJSON(`/llm/phase/${name}`, config)
export const updateLLMAgent    = (name, config) => putJSON(`/llm/agent/${name}`, config)
export const updateLLMProvider = (name, config) => putJSON(`/llm/provider/${name}`, config)

export const testLLMProvider   = (name, model) => postJSON(`/llm/test/${name}`, model ? { model } : {})
export const resetLLMStats     = () => postJSON('/llm/reset-stats')

export const fetchLLMProviderHealth = () => fetchJSON('/llm/provider-health')
export const fetchLLMRouteAnalytics = () => fetchJSON('/llm/route-analytics')
