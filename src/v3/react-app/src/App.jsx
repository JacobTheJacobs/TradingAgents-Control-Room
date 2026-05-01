import { useState, useEffect, useRef, useCallback } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import TradingFloorPage from './components/TradingFloorPage'
import AdminOverlayPage from './components/AdminOverlayPage'
import BackendOfflineOverlay from './components/BackendOfflineOverlay'
import { fetchPortfolio } from './services/api'
import { TradingFloorProvider, useTradingFloor } from './context/TradingFloorContext'
import { ROOM_MAP } from './utils/constants'
import { STEP_SCENES } from './config/stepScenes'
import {
  normalizeTradingAgentId,
  normalizeTradingAgentName,
  TRADING_AGENT_BY_ID,
  TRADING_AGENT_IDS,
  TRADING_AGENT_NAMES,
  getTradingAgentRawStateReportValues,
  TRADING_AGENT_REPORT_CARD_DEFS,
  TRADING_AGENT_REPORT_KEY_BY_AGENT,
  TRADING_AGENT_SCENE_MAP,
  TRADING_AGENT_TIMELINE_SCENE_BY_AGENT,
  TRADING_AGENT_WORKFLOW_STEPS,
} from './config/tradingAgentsRoster'

const PIPELINE_SCENE_KEY_ALIASES = {
  MARKET: 'STEP_1_ANALYSTS',
  SOCIAL: 'STEP_1_ANALYSTS',
  NEWS: 'STEP_1_ANALYSTS',
  FUNDS: 'STEP_1_ANALYSTS',
  FUNDAMENTALS: 'STEP_1_ANALYSTS',
  ANALYSTS: 'STEP_1_ANALYSTS',
  BULL: 'STEP_2_RESEARCH',
  BEAR: 'STEP_2_RESEARCH',
  RM: 'STEP_2_RESEARCH',
  RESEARCH: 'STEP_2_RESEARCH',
  TRADER: 'STEP_3_TRADER',
  AGGR: 'STEP_4_RISK',
  AGGRESSIVE: 'STEP_4_RISK',
  CONS: 'STEP_4_RISK',
  CONSERVATIVE: 'STEP_4_RISK',
  NEUTRAL: 'STEP_4_RISK',
  RISK: 'STEP_4_RISK',
  JUDGE: 'STEP_5_PORTFOLIO',
  PORTFOLIO: 'STEP_5_PORTFOLIO',
  PORTFOLIO_MANAGER: 'STEP_5_PORTFOLIO',
  DECISION: 'STEP_5_PORTFOLIO',
}

const isActiveTradingAgentsPhase = (payload = {}) => {
  const phaseNum = Number(payload?.phase_num || payload?.current_phase || 0)
  const phase = String(payload?.phase || payload?.sub_phase || '').toUpperCase()
  return (
    phaseNum > 0 &&
    phase !== 'IDLE' &&
    phase !== 'READY' &&
    phase !== 'COMPLETE' &&
    phase !== 'FAILED' &&
    phase !== 'ABORTED'
  )
}

const cloneSceneConfig = (scene = {}) => ({
  ...scene,
  agents: Array.isArray(scene.agents) ? [...scene.agents] : [],
  animations: { ...(scene.animations || {}) },
  stations: { ...(scene.stations || {}) },
  paths: { ...(scene.paths || {}) },
})

const isTradingAgentsTimelineSceneKey = (key = '') => /^TA_TIMELINE_\d{2}_[A-Z_]+$/.test(String(key || ''))

const normalizeSceneValueMap = (map = {}) => {
  const next = {}
  Object.entries(map || {}).forEach(([agent, value]) => {
    if (agent === 'default') {
      next.default = value
      return
    }
    const canonical = normalizeTradingAgentName(agent)
    if (canonical) next[canonical] = value
  })
  return next
}

const normalizePipelineSceneOverrides = (config = {}) => {
  const next = {}
  Object.entries(config || {}).forEach(([sceneKey, override]) => {
    if (!override) return
    const normalizedKey = PIPELINE_SCENE_KEY_ALIASES[sceneKey] || sceneKey
    if (isTradingAgentsTimelineSceneKey(normalizedKey)) {
      const normalizedAgents = Array.isArray(override.agents)
        ? [...new Set(override.agents.map((agent) => normalizeTradingAgentName(agent) || agent).filter(Boolean))]
        : []
      const animations = normalizeSceneValueMap(override.animations)
      const stations = normalizeSceneValueMap(override.stations)
      const paths = normalizeSceneValueMap(override.paths)
      const isBrokenEmptyTimeline =
        override.__explicit === true &&
        override.__allow_empty_agents !== true &&
        normalizedAgents.length === 0 &&
        Object.keys(animations).length === 0 &&
        Object.keys(stations).length === 0 &&
        Object.keys(paths).length === 0
      if (isBrokenEmptyTimeline) return
      next[normalizedKey] = {
        ...(override.location ? { location: override.location } : {}),
        ...(normalizedAgents.length > 0 ? { agents: normalizedAgents } : {}),
        ...(Object.keys(animations).length > 0 ? { animations } : {}),
        ...(Object.keys(stations).length > 0 ? { stations } : {}),
        ...(Object.keys(paths).length > 0 ? { paths } : {}),
        ...(override.__explicit ? { __explicit: true } : {}),
        ...(override.__allow_empty_agents ? { __allow_empty_agents: true } : {}),
      }
      return
    }
    const baseScene = STEP_SCENES[normalizedKey]
    if (!baseScene) return
    const normalizedAgents = Array.isArray(override.agents)
      ? [...new Set(override.agents.map((agent) => normalizeTradingAgentName(agent) || agent).filter(Boolean))]
      : undefined
    const isExplicitOverride = Boolean(override.__explicit)
    const stripMatchingEntries = (map = {}, baseMap = {}) => {
      const filtered = {}
      Object.entries(normalizeSceneValueMap(map)).forEach(([agent, value]) => {
        const baseValue =
          agent === 'default'
            ? baseMap.default
            : (baseMap[agent] || baseMap.default)
        if (value !== baseValue) filtered[agent] = value
      })
      return filtered
    }
    const sameAgents =
      Array.isArray(normalizedAgents) &&
      normalizedAgents.length === (baseScene.agents || []).length &&
      normalizedAgents.every((agent, index) => agent === baseScene.agents[index])
    const animations = isExplicitOverride
      ? normalizeSceneValueMap(override.animations)
      : stripMatchingEntries(override.animations, baseScene.animations || {})
    const stations = isExplicitOverride
      ? normalizeSceneValueMap(override.stations)
      : stripMatchingEntries(override.stations, baseScene.stations || {})
    const paths = isExplicitOverride
      ? normalizeSceneValueMap(override.paths)
      : stripMatchingEntries(override.paths, baseScene.paths || {})
    next[normalizedKey] = {
      ...(override.location && (isExplicitOverride || override.location !== baseScene.location) ? { location: override.location } : {}),
      ...(Array.isArray(normalizedAgents) && (isExplicitOverride || !sameAgents) ? { agents: normalizedAgents } : {}),
      ...(Object.keys(animations).length > 0 ? { animations } : {}),
      ...(Object.keys(stations).length > 0 ? { stations } : {}),
      ...(Object.keys(paths).length > 0 ? { paths } : {}),
    }
  })
  return next
}

const normalizeAgentBehaviorDefaults = (defaults = {}) => {
  const next = {}
  Object.entries(defaults || {}).forEach(([key, value]) => {
    const agentId =
      normalizeTradingAgentId(value?.id) ||
      normalizeTradingAgentId(key) ||
      normalizeTradingAgentId(value?.displayName)
    if (!agentId) return

    const displayName = normalizeTradingAgentName(agentId) || value?.displayName || TRADING_AGENT_BY_ID[agentId]?.name
    const normalized = {
      ...value,
      id: agentId,
      displayName,
      default_animation: value?.default_animation || value?.animation || 'idle',
      default_station: value?.default_station || value?.station || TRADING_AGENT_BY_ID[agentId]?.station,
      default_path: value?.default_path || 'direct',
    }

    next[agentId] = normalized
    if (displayName) next[displayName] = normalized
  })
  return next
}

const isHeaderOnlyReport = (value = '') => {
  const cleaned = String(value || '').trim()
  if (!cleaned) return true
  const lines = cleaned.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return true
  const headerPattern = /^FINAL\s+(?:RECOMMENDATION|TRANSACTION\s+PROPOSAL|ACTION)\s*[:\-\s]*\**\s*(BUY|SELL|HOLD|LIQUIDATE|NEUTRAL)?\**$/i
  if (lines.length === 1 && headerPattern.test(lines[0])) return true
  if (lines.length === 2 && headerPattern.test(lines[0]) && lines[1].length < 20) return true
  return false
}

const looksLikeToolNoise = (value = '') => {
  const text = String(value || '')
  if (!text.trim()) return true
  if (/<tool_call>|<\/tool_call>|[\"'](?:name|parameters|arguments|args)[\"']\s*:/i.test(text)) return true
  return /i[’']?ll\s+try|i[’']?ll\s+try\s+a\s+different|let\s+me\s+correct|let\s+me\s+proceed|i(?:'|’)ll\s+now|i[’']?ll\s+help\s+you\s+conduct/i.test(text)
}

const looksLikePortfolioSnapshotBlock = (value = '') => {
  const text = String(value || '')
  if (!text.trim()) return false
  const patterns = [
    /ASSETS:\s*\$/i,
    /SSETS:\s*\$/i,
    /\|\s*CASH:\s*\$/i,
    /CLOSED WIN/i,
    /EXCESS RETURN vs S&P 500/i,
    /===\s*ACTIVE POSITIONS\s*===/i,
    /\bPositions\b/i,
    /\b0\s+ACTIVE\b/i,
    /===\s*PORTFOLIO ANALYTICS\s*===/i,
    /\bNo active positions\b/i,
    /\bPortfolio Return\b/i,
    /\bS&P Return\b/i,
    /\bUnrealized P&L\b/i,
    /\bRealized P&L\b/i,
    /\bCash Weight\b/i,
    /\bTop Position\b/i,
    /\bOpen Positions\b/i,
    /\bClosed Trades\b/i,
  ]
  return patterns.some((pattern) => pattern.test(text))
}

const isSubstantiveReportText = (value = '') => {
  const text = String(value || '')
  if (!text.trim()) return false
  const sentenceCount = (text.match(/[.!?]/g) || []).length
  const hasStructure = /\n\s*(?:[-*•]|\d+\.)\s+/m.test(text) || /^#{1,6}\s+/m.test(text) || /\n\s*\|.+\|/.test(text)
  return text.length >= 900 || sentenceCount >= 9 || (text.length >= 520 && sentenceCount >= 5 && hasStructure)
}

const looksLikeDraftScaffold = (value = '') => {
  const text = String(value || '')
  if (!text.trim()) return false
  const intro = text.slice(0, 420)
  const substantive = isSubstantiveReportText(text)
  const hasFinalMarkers = /\b(final\s+(?:recommendation|transaction\s+proposal|decision)|executive\s+brief)\b/i.test(text)
  if (substantive && hasFinalMarkers) return false
  const draftPattern = /now\s+that\s+i\s+have|i\s+see\s+you(?:['’]ve|\s+have)\s+provided|let\s+me\s+consolidate|let\s+me\s+gather|let\s+me\s+check|let\s+me\s+fetch|let\s+me\s+retrieve|let\s+me\s+get|let\s+me\s+search|let\s+me\s+look|let\s+me\s+verify|let\s+me\s+(?:attempt|reattempt|retry)|let\s+me\s+continue|let\s+me\s+adjust|it\s+appears\s+that\s+no\s+financial\s+statement\s+data\s+is\s+available|i\s+will\s+execute\s+the\s+required\s+tool\s+call\s+first|the\s+error\s+seems\s+to\s+be\s+related\s+to|i(?:'|’)ll\s+retrieve|i(?:'|’)ll\s+analy[sz]e|i(?:'|’)ll\s+check|i(?:'|’)ll\s+fetch|i(?:'|’)ll\s+gather|i(?:'|’)ll\s+search|i(?:'|’)ll\s+look|i(?:'|’)ll\s+verify|i(?:'|’)ll\s+use\s+the|i\s+will\s+(?:now\s+)?(?:check|fetch|retrieve|gather|search|look|verify|execute|retry|analy[sz]e)|let\s+me\s+start\s+with\s+retrieving|let\s+me\s+refine\s+the\s+query/i
  return draftPattern.test(intro) && !substantive
}

const reportQualityScore = (value = '') => {
  const text = String(value || '').trim()
  if (!text) return 0
  let score = text.length
  if (/action\s+plan|executive\s+summary/i.test(text)) score += 200
  if ((text.match(/\n/g) || []).length >= 4) score += 50
  if (/^\s*(?:[-*•]|\d+\.)\s+/m.test(text)) score += 50
  return score
}

const isDisplayReadyReport = (value = '') => {
  const text = String(value || '').trim()
  if (!text) return false
  if (isHeaderOnlyReport(text)) return false
  if (/^\s*[\{\[]/.test(text) && /[\"']name[\"']\s*:/.test(text)) return false
  const sentenceCount = (text.match(/[.!?]/g) || []).length
  const lineBreaks = (text.match(/\n/g) || []).length
  if (looksLikeToolNoise(text)) return false
  if (looksLikeDraftScaffold(text)) return false
  if (text.length < 80 && !/^\s*(?:[-*•]|\d+\.)\s+/m.test(text) && lineBreaks < 1 && sentenceCount < 1) return false
  return true
}

const isArchiveReadyReport = (value = '') => {
  const text = String(value || '').trim()
  if (!text) return false
  if (isHeaderOnlyReport(text)) return false
  if (/^\s*[\{\[]/.test(text) && /[\"']name[\"']\s*:/.test(text)) return false
  const lineBreaks = (text.match(/\n/g) || []).length
  const sentenceCount = (text.match(/[.!?]/g) || []).length
  if (looksLikeToolNoise(text)) return false
  if (looksLikeDraftScaffold(text)) return false
  if (text.length < 80 && !/^\s*(?:[-*•]|\d+\.)\s+/m.test(text) && lineBreaks < 1 && sentenceCount < 1) return false
  return true
}

const looksLikeFullTaReport = (value = '') => {
  const text = String(value || '').trim()
  if (!text) return false
  if (!isDisplayReadyReport(text)) return false
  if (text.length >= 280) return true
  if ((text.match(/\n/g) || []).length >= 4) return true
  if (/^\s*(?:[-*•]|\d+\.)\s+/m.test(text)) return true
  if (/executive\s+summary|action\s+plan/i.test(text)) return true
  return text.length >= 120
}

const isTransientTransportError = (error) => {
  const message = String(error?.message || error || '')
  return (
    /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED|ERR_ABORTED|aborted|fetch/i.test(message) ||
    error?.name === 'AbortError'
  )
}

const BACKEND_STATUS = {
  STARTING: 'starting',
  LIVE: 'live',
  OFFLINE: 'offline',
  RECOVERING: 'recovering',
}

const formatBackendError = (error, fallback = 'Connection failed.') => {
  const message = String(error?.message || error || '').trim()
  return message || fallback
}

const describeWsCloseEvent = (event) => {
  if (!event) return 'WebSocket closed.'
  if (event.reason) return `WebSocket closed: ${event.reason}`
  if (event.code) return `WebSocket closed with code ${event.code}`
  return 'WebSocket closed.'
}

const isBackendShellPath = (pathname = '') => (
  pathname === '/' ||
  pathname.startsWith('/admin')
)

const buildBackendTargets = () => {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const candidates = [
    {
      key: 'direct',
      label: 'Direct backend',
      wsUrl: `${wsProtocol}//127.0.0.1:8001/trading-floor/ws`,
      probeUrl: '/trading-floor/flow/state',
    },
    {
      key: 'proxy',
      label: 'Frontend proxy',
      wsUrl: `${wsProtocol}//${window.location.host}/trading-floor/ws`,
      probeUrl: '/trading-floor/flow/state',
    },
  ]

  return candidates.filter((candidate, index, items) => (
    items.findIndex((entry) => entry.wsUrl === candidate.wsUrl) === index
  ))
}

const REPORT_TEXT_KEYS = [
  'report',
  'final_trade_decision',
  'final_decision',
  'judge_decision',
  'current_response',
  'reasoning',
  'content',
  'text',
  'message',
  'output',
  'analysis',
  'decision',
]

const extractReportTextPayload = (value, options = {}, seen = new WeakSet()) => {
  const { includeSummary = false } = options
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()

  if (Array.isArray(value)) {
    const candidates = value
      .map((item) => extractReportTextPayload(item, options, seen))
      .filter(Boolean)
    if (candidates.length === 0) return ''
    let best = ''
    let bestScore = -1
    candidates.forEach((candidate) => {
      if (!candidate) return
      if (isDisplayReadyReport(candidate)) {
        const score = reportQualityScore(candidate)
        if (score > bestScore) {
          bestScore = score
          best = candidate
        }
      }
    })
    if (best) return best.trim()
    return candidates.reduce((acc, item) => (item.length > acc.length ? item : acc), candidates[0]).trim()
  }

  if (typeof value !== 'object') return ''
  if (seen.has(value)) return ''
  seen.add(value)

  const candidateKeys = includeSummary ? [...REPORT_TEXT_KEYS, 'summary'] : REPORT_TEXT_KEYS
  for (const key of candidateKeys) {
    const nested = extractReportTextPayload(value[key], options, seen)
    if (nested) return nested
  }

  return ''
}

const resolveLiveTaReportIdentity = (payload = {}) => {
  const agentId = normalizeTradingAgentId(
    payload?.current_step ||
    payload?.agent ||
    payload?.agent_display_name
  )
  const reportKey = agentId || null
  const agentName =
    normalizeTradingAgentName(payload?.agent_display_name || payload?.current_step || payload?.agent || agentId) ||
    (agentId ? TRADING_AGENT_BY_ID[agentId]?.name : null) ||
    null

  return { agentId, reportKey, agentName }
}

const buildLiveTaReportEntry = (payload = {}) => {
  const { agentId, reportKey, agentName } = resolveLiveTaReportIdentity(payload)
  if (!agentId || !reportKey) return null

  const explicitReport = extractReportTextPayload(payload?.report)
  const reasoningReport = extractReportTextPayload(payload?.reasoning)
  const rawText = mergePreferredFullReport(explicitReport, reasoningReport)
  const resolvedText = rawText && isDisplayReadyReport(rawText) ? rawText : ''

  if (!resolvedText || !isDisplayReadyReport(resolvedText)) return null

  return {
    key: reportKey,
    agentId,
    agentName: agentName || TRADING_AGENT_BY_ID[agentId]?.name || agentId,
    report: resolvedText,
    rawText: resolvedText,
    reasoning: resolvedText,
    summary: '',
    timestamp: payload?.timestamp || new Date().toISOString(),
  }
}

const mergeLiveTaReportsFromSnapshot = (previousReports = {}, snapshot = {}) => {
  const nextReports = { ...(previousReports || {}) }

  Object.entries(snapshot || {}).forEach(([agentKey, agentState]) => {
    const identity = resolveLiveTaReportIdentity({
      agent: agentKey,
      agent_display_name: agentState?.displayName || agentState?.agent || agentKey,
    })
    if (!identity.agentId || !identity.reportKey) return

    const explicitReport = extractReportTextPayload(agentState?.report)
    const reasoningReport = extractReportTextPayload(agentState?.reasoning)
    const rawText = mergePreferredFullReport(explicitReport, reasoningReport)
    const resolvedText = rawText && isDisplayReadyReport(rawText) ? rawText : ''

    if (!resolvedText) return

    const existing = nextReports[identity.reportKey] || {}
    const preferredText = mergePreferredFullReport(existing.rawText || existing.report || '', resolvedText)
    if (!preferredText) return
    nextReports[identity.reportKey] = {
      ...existing,
      key: identity.reportKey,
      agentId: identity.agentId,
      agentName: identity.agentName,
      report: preferredText,
      rawText: preferredText,
      reasoning: preferredText,
      summary: existing.summary || '',
    }
  })

  return nextReports
}

const resolveAgentFullReportText = (report) => extractReportTextPayload(
  report?.report ||
  report?.reasoning ||
  report?.text ||
  report?.dialogue
)

const resolveAgentSummaryText = (report) => {
  const summary = extractReportTextPayload(
    report?.summary ||
    report?.summary_text ||
    report?.report_excerpt ||
    report?.excerpt ||
    '',
    { includeSummary: true }
  )
  const cleaned = String(summary || '').trim()
  if (!cleaned) return ''
  if (looksLikeToolNoise(cleaned)) return ''
  return cleaned
}

const mergePreferredFullReport = (existingText = '', candidateText = '') => {
  const existing = String(existingText || '').trim()
  const candidate = String(candidateText || '').trim()
  if (!candidate || !isDisplayReadyReport(candidate)) return existing
  if (!existing || !isDisplayReadyReport(existing)) return candidate
  return reportQualityScore(candidate) >= reportQualityScore(existing) ? candidate : existing
}

const resolveAgentRawReportText = (rawState = {}, agentId = '') => {
  if (!rawState || !agentId) return ''
  const candidates = getTradingAgentRawStateReportValues(rawState, agentId)
  if (!Array.isArray(candidates) || candidates.length === 0) return ''
  return extractReportTextPayload(candidates)
}

const normalizeLiveDialogueMap = (dialogueMap = {}) => {
  const next = {}
  Object.entries(dialogueMap || {}).forEach(([sceneKey, lines]) => {
    const normalizedKey = PIPELINE_SCENE_KEY_ALIASES[sceneKey] || sceneKey
    if (!STEP_SCENES[normalizedKey] || !Array.isArray(lines)) return
    next[normalizedKey] = lines
      .map((line) => ({
        ...line,
        agent: normalizeTradingAgentName(line?.agent) || line?.agent,
        text: typeof line?.text === 'string' ? line.text.trim() : '',
      }))
      .filter((line) => line.agent && line.text)
  })
  return next
}

const TA_ALLOWED_ANIMATIONS = new Set([
  'talk',
  'read',
  'point',
  'argue',
  'sit_type',
  'sit_back',
  'idle',
  'buy',
  'sell',
  'cheer',
  'facepalm',
  'hodl',
  'rekt',
  'copium',
])

const TA_ALLOWED_PATHS = new Set(['direct', 'detour', 'loop', 'idle'])

const normalizeTaAnimation = (value, fallback = 'idle') => {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')
  if (normalized === 'think') return 'idle'
  if (TA_ALLOWED_ANIMATIONS.has(normalized)) return normalized
  const fallbackNormalized = String(fallback || 'idle').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')
  return TA_ALLOWED_ANIMATIONS.has(fallbackNormalized) ? fallbackNormalized : 'idle'
}

const normalizeTaPath = (value, fallback = 'direct') => {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')
  if (TA_ALLOWED_PATHS.has(normalized)) return normalized
  const fallbackNormalized = String(fallback || 'direct').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_')
  return TA_ALLOWED_PATHS.has(fallbackNormalized) ? fallbackNormalized : 'direct'
}

const normalizeTaPerform = (value, fallback = true) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return !!fallback
}

const normalizeTaBehaviorProfile = (value = {}, fallback = {}) => ({
  animation: normalizeTaAnimation(value?.animation, fallback?.animation || 'idle'),
  path: normalizeTaPath(value?.path, fallback?.path || 'direct'),
  perform: normalizeTaPerform(value?.perform, fallback?.perform ?? true),
})

const normalizeTaBackgroundProfiles = (profiles = {}) => {
  const next = {}
  Object.entries(profiles || {}).forEach(([agentKey, value]) => {
    const canonicalName =
      normalizeTradingAgentName(agentKey) ||
      normalizeTradingAgentName(normalizeTradingAgentId(agentKey))
    if (!canonicalName) return
    next[canonicalName] = normalizeTaBehaviorProfile(value)
  })
  return next
}

const normalizeTaBackgroundProfilesByScene = (profilesByScene = {}) => {
  const next = {}
  Object.entries(profilesByScene || {}).forEach(([sceneKey, profiles]) => {
    const normalizedKey = PIPELINE_SCENE_KEY_ALIASES[sceneKey] || sceneKey
    if (!STEP_SCENES[normalizedKey]) return
    next[normalizedKey] = normalizeTaBackgroundProfiles(profiles)
  })
  return next
}

const normalizeTaForegroundOverride = (override = {}) => {
  const agent =
    normalizeTradingAgentName(override?.agent) ||
    normalizeTradingAgentName(override?.agent_display_name) ||
    normalizeTradingAgentName(override?.current_step) ||
    normalizeTradingAgentName(normalizeTradingAgentId(override?.agent || override?.agent_display_name || override?.current_step))
  if (!agent) return null
  return {
    agent,
    current_step: normalizeTradingAgentId(override?.current_step || override?.agent || override?.agent_display_name),
    dialogue: typeof override?.dialogue === 'string' ? override.dialogue.trim() : '',
    animation: normalizeTaAnimation(override?.animation, 'idle'),
    path: normalizeTaPath(override?.path, 'direct'),
    perform: normalizeTaPerform(override?.perform, true),
    timestamp: override?.timestamp,
  }
}

const normalizeTaForegroundOverrideMap = (overrides = {}) => {
  const next = {}
  Object.entries(overrides || {}).forEach(([sceneKey, override]) => {
    const normalizedKey = PIPELINE_SCENE_KEY_ALIASES[sceneKey] || sceneKey
    if (!STEP_SCENES[normalizedKey]) return
    const normalizedOverride = normalizeTaForegroundOverride(override)
    if (normalizedOverride) next[normalizedKey] = normalizedOverride
  })
  return next
}

const resolvePassiveTradingAgentStation = (agentName, behavior = {}) => {
  const agentId = normalizeTradingAgentId(agentName)
  const defaultStation =
    behavior?.default_station ||
    TRADING_AGENT_BY_ID[agentId || '']?.station ||
    'desk'
  return defaultStation
}

const normalizeLivePortfolioPayload = (payload = {}) => {
  const portfolioSource = payload?.portfolio || payload || {}
  const performanceSummary = payload?.performance_summary || portfolioSource?.performance_summary || {}
  const analytics = payload?.analytics || portfolioSource?.analytics || {}
  const spyBenchmark = payload?.spy_benchmark || {
    aggregate: {
      fund_return: performanceSummary?.portfolio_return_pct ?? 0,
      spy_return: performanceSummary?.sp500_return_pct ?? 0,
      alpha: performanceSummary?.alpha_pct ?? 0,
    },
    by_position: {},
  }
  const closedTrades = Array.isArray(payload?.closed_trades)
    ? payload.closed_trades
    : Array.isArray(portfolioSource?.closed_trades)
      ? portfolioSource.closed_trades
      : []
  const benchmark = portfolioSource?.benchmark || {
    daily_alpha_24h: performanceSummary?.alpha_pct ?? 0,
    daily_spy_return_24h: performanceSummary?.sp500_return_pct ?? 0,
    cumulative_alpha: performanceSummary?.alpha_pct ?? 0,
    cumulative_spy_return: performanceSummary?.sp500_return_pct ?? 0,
  }

  const portfolio = {
    ...portfolioSource,
    performance_summary: performanceSummary,
    analytics,
    closed_trades: closedTrades,
    benchmark,
  }

  return {
    portfolio,
    analytics,
    spyBenchmark,
    closedTrades,
    snapshot: {
      ...portfolio,
      analytics,
      spy_benchmark: spyBenchmark,
      closed_trades: closedTrades,
    },
  }
}

// Helper to redirect existing #/ routes to / routes
function HashRedirect() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (window.location.hash) {
      const hash = window.location.hash.substring(1); // remove #
      const cleanPath = hash.startsWith('/') ? hash : `/${hash}`;

      // Map old paths to new ones if necessary, otherwise just navigate
      if (cleanPath === '/floor' || cleanPath === '/analyze' || cleanPath === '/monitor' || cleanPath === '/flow') {
        navigate('/', { replace: true });
      } else if (cleanPath === '/admin') {
        navigate('/admin', { replace: true });
      } else if (cleanPath && cleanPath !== '/') {
        navigate('/', { replace: true });
      }
    }
  }, [navigate]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <TradingFloorProvider>
        <HashRedirect />
        <AppContent />
      </TradingFloorProvider>
    </BrowserRouter>
  );
}

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const { 
    state,
    addLog, setPortfolio, setSchedulePhase, setConnected, setBackendHealth, setSpyData, 
    setAgentStates, setMarqueeSpeed, setNewsScrollSpeed,
    setHideNews, setHideCycle, setHideLeftSidebar, setHideRightSidebar, setShowPerformanceView,
    setLightMode, setPipelineState, addZoneEvent, setClosedTrades, setExecutionHistory, setAnalytics,
    setSpyBenchmark, setZoneEvents, setActiveScene, setDialogue, addStreamedNews, appendLiveNews, setMarqueeText,
    refreshAgents, setTaRunStats, resetTaRunStats, setLiveTaReports, broadcastUISettings
  } = useTradingFloor();

  const { 
    connected, agentStates, portfolio, spyBenchmark, closedTrades, analytics,
    zoneEvents, marqueeSpeed, newsScrollSpeed, hideNews, hideCycle,
    hideLeftSidebar, hideRightSidebar, showPerformanceView, lightMode, schedulePhase,
    agents, agentNameMap, backendHealth
  } = state;

  // ── Mode state ── ("automatic" | "manual" | null = not chosen yet)
  const [mode, setMode] = useState(null)

  // ── Shared state ── (Now driven mostly by context)
  const [messages, setMessages] = useState([])
  const [currentTicker, setCurrentTicker] = useState(null)
  const [pipelinePhase, setPipelinePhase] = useState('idle')
  const [regime, setRegime] = useState(null)
  const [premortemData, setPremortemData] = useState(null)
  const [warRoomBrief, setWarRoomBrief] = useState(null)
  const [stepScript, setStepScript] = useState(null)
  const [stepScriptMeta, setStepScriptMeta] = useState(null)
  const [queue, setQueue] = useState([])
  const [tickerQueue, setTickerQueue] = useState([])
  const [pipelineHistory, setPipelineHistory] = useState([])
  const [cycle, setCycle] = useState(0)

  const wsRef = useRef(null)
  const wsProbeRef = useRef(false)
  const wsDegradedRef = useRef(false)
  const reconnectRef = useRef(null)
  const manualReconnectRef = useRef(false)
  const backendTargetsRef = useRef([])
  const wsHostIndexRef = useRef(0)
  const lastGoodHostIndexRef = useRef(null)
  const unmountedRef = useRef(false)
  const activeTaRunIdRef = useRef(null)
  const agentBehaviorDefaultsRef = useRef({})
  const pipelineScenesRef = useRef({})
  const liveStepDialogueRef = useRef({})
  const taBackgroundProfilesRef = useRef({})
  const taForegroundOverrideRef = useRef({})
  const taCanonicalSceneHistoryRef = useRef({})
  const taCanonicalSceneAttemptRef = useRef({})
  const canonicalSceneQueueRef = useRef([])
  const activeCanonicalSceneKeyRef = useRef(null)
  const warnedSceneConfigRunsRef = useRef({})
  const oracleDialogueQueueRef = useRef([])
  const oracleDialogueTimerRef = useRef(null)
  const agentStatesRef = useRef(agentStates)
  const taRunStatsRef = useRef(state.taRunStats)
  const pipelineStateRef = useRef(state.pipelineState)
  const currentTickerRef = useRef(currentTicker)
  const cycleRef = useRef(cycle)
  const lastUiLogChunkRef = useRef('')

  useEffect(() => {
    agentStatesRef.current = agentStates
  }, [agentStates])

  useEffect(() => {
    taRunStatsRef.current = state.taRunStats
    pipelineStateRef.current = state.pipelineState
  }, [state.taRunStats, state.pipelineState])

  useEffect(() => {
    currentTickerRef.current = currentTicker
  }, [currentTicker])

  useEffect(() => {
    cycleRef.current = cycle
  }, [cycle])

  const transitionBackendHealth = useCallback((status, options = {}) => {
    const at = options.at || new Date().toISOString()
    setBackendHealth((prev) => {
      const next = {
        ...prev,
        status,
        activeHost: options.activeHost !== undefined ? options.activeHost : prev.activeHost,
        currentMessage: options.currentMessage !== undefined ? options.currentMessage : prev.currentMessage,
      }

      if (options.failureReason) {
        next.lastFailureReason = options.failureReason
        next.lastFailureAt = at
      }

      if (status === BACKEND_STATUS.LIVE) {
        next.lastHealthyAt = at
        if (!next.currentMessage) {
          next.currentMessage = 'Backend link healthy.'
        }
      }

      return next
    })
  }, [setBackendHealth])

  const getCurrentBackendTarget = useCallback(() => {
    if (!backendTargetsRef.current.length) {
      backendTargetsRef.current = buildBackendTargets()
    }
    if (!backendTargetsRef.current.length) return null
    if (wsHostIndexRef.current >= backendTargetsRef.current.length) {
      wsHostIndexRef.current = 0
    }
    return backendTargetsRef.current[wsHostIndexRef.current]
  }, [])

  const rotateBackendTarget = useCallback(() => {
    if (!backendTargetsRef.current.length) {
      backendTargetsRef.current = buildBackendTargets()
    }
    if (backendTargetsRef.current.length <= 1) {
      return backendTargetsRef.current[0] || null
    }
    wsHostIndexRef.current = (wsHostIndexRef.current + 1) % backendTargetsRef.current.length
    return backendTargetsRef.current[wsHostIndexRef.current]
  }, [])

  const addMessage = useCallback((msg) => {
    const withTs = { ...msg, timestamp: msg.timestamp || new Date().toISOString() }
    setMessages(prev => [...prev.slice(-200), withTs])

    // Also add to pipeline history for step-by-step tracking
    const shouldAddToHistory = (
      msg.type === 'agent_action' ||
      msg.type === 'agent_completed' || 
      msg.type === 'phase_start' || 
      msg.type === 'phase_completed' ||
      (msg.type === 'console_output' && window._taPhaseActive)
    );
    
    if (shouldAddToHistory) {
      setPipelineHistory(prev => [...prev.slice(-500), withTs])
    }
  }, [])

  const mergePipelineProgress = useCallback((prevState = {}, nextState = {}) => {
    const prev = prevState || {}
    const next = nextState || {}
    const nextRunId = next.active_run_id || next.run_id || null
    const prevRunId = prev.active_run_id || prev.run_id || null
    const nextStepId = normalizeTradingAgentId(
      next.current_step || next.agent || next.agent_display_name
    )
    const merged = {
      ...prev,
      ...next,
      ...(nextRunId ? { active_run_id: nextRunId } : {}),
    }
    const prevPhase = Number(prev.phase_num ?? prev.current_phase ?? 0) || 0
    const nextPhase = Number(next.phase_num ?? next.current_phase ?? 0) || 0
    const nextType = String(next.type || '')
    const nextAction = String(next.action || next.message || '')
    const nextPhaseLabel = String(next.phase || next.sub_phase || '')
    const prevPhaseUpper = String(prev.phase || '').toUpperCase()
    const prevStatusUpper = String(prev.status || '').toUpperCase()
    const nextPhaseUpper = String(next.phase || '').toUpperCase()
    const nextStatusUpper = String(next.status || '').toUpperCase()
    const prevTerminalTradingAgents =
      String(prev.pipeline_mode || '').toLowerCase() === 'tradingagents' &&
      (
        ['COMPLETE', 'FAILED', 'ABORTED'].includes(prevPhaseUpper) ||
        ['COMPLETE', 'FAILED', 'ABORTED'].includes(prevStatusUpper)
      )
    const nextIdleReset =
      (nextPhaseUpper === 'IDLE' || nextStatusUpper === 'IDLE') &&
      !nextRunId &&
      nextType !== 'pipeline_start'
    if (prevTerminalTradingAgents && nextIdleReset) {
      return prev
    }
    const isRunReset =
      nextType === 'pipeline_start' ||
      (
        nextRunId &&
        prevRunId &&
        nextRunId === prevRunId &&
        prevPhase > nextPhase &&
        nextPhase <= 1 &&
        nextStepId === 'market_analyst'
      ) ||
      (
        nextPhase <= 1 &&
        /start/i.test(nextAction) &&
        /init|data_collection|agent_analysis/i.test(nextPhaseLabel)
      )

    if (prevPhase > 0 && nextPhase > 0 && nextPhase < prevPhase && !isRunReset) {
      merged.phase_num = prev.phase_num ?? prevPhase
      if (prev.current_phase !== undefined) merged.current_phase = prev.current_phase
      if (prev.phase !== undefined) merged.phase = prev.phase
      if (prev.current_step !== undefined) merged.current_step = prev.current_step
      if (prev.agent_display_name !== undefined) merged.agent_display_name = prev.agent_display_name
      if (prev.action !== undefined) merged.action = prev.action
      if (prev.status !== undefined) merged.status = prev.status
    }

    return merged
  }, [])

  const hasPipelineStateDelta = useCallback((prevState = {}, nextState = {}) => {
    if (prevState === nextState) return false
    const keys = [
      'pipeline_mode',
      'phase',
      'phase_num',
      'current_phase',
      'current_step',
      'agent_display_name',
      'status',
      'action',
      'ticker',
      'current_ticker',
      'cycle',
      'active_run_id',
      'run_id',
      'reports_completed',
      'agents_completed',
      'llm_calls',
      'tool_calls',
    ]
    for (const key of keys) {
      if (prevState?.[key] !== nextState?.[key]) return true
    }
    return false
  }, [])

  const applyAgentBehaviorDefaults = useCallback((defaults) => {
    agentBehaviorDefaultsRef.current = normalizeAgentBehaviorDefaults(defaults)
  }, [])

  const applyPipelineScenesConfig = useCallback((config) => {
    pipelineScenesRef.current = normalizePipelineSceneOverrides(config)
  }, [])

  const applyLiveStepDialogue = useCallback((dialogueMap) => {
    liveStepDialogueRef.current = normalizeLiveDialogueMap(dialogueMap)
  }, [])

  const applyTaBackgroundProfiles = useCallback((profilesByScene) => {
    taBackgroundProfilesRef.current = normalizeTaBackgroundProfilesByScene(profilesByScene)
  }, [])

  const applyTaForegroundOverride = useCallback((overrides) => {
    taForegroundOverrideRef.current = normalizeTaForegroundOverrideMap(overrides)
  }, [])

  const presentOracleDialogue = useCallback((dialogueItem) => {
    if (!dialogueItem?.text) return
    setDialogue(dialogueItem.agent, dialogueItem.text, dialogueItem.type)
    if (oracleDialogueTimerRef.current) clearTimeout(oracleDialogueTimerRef.current)
    if (oracleDialogueQueueRef.current.length > 0) {
      oracleDialogueTimerRef.current = setTimeout(() => {
        if (state.activeScene) return
        const nextOracle = oracleDialogueQueueRef.current.shift()
        if (nextOracle) presentOracleDialogue(nextOracle)
      }, 7000)
    }
  }, [setDialogue, state.activeScene])

  const queueOracleDialogue = useCallback((payload = {}) => {
    const answer = String(payload?.answer || payload?.item?.answer || '').trim()
    if (!answer) return
    const dialogueItem = { agent: 'Oracle', text: answer, type: 'oracle_question' }
    if (state.activeScene) {
      oracleDialogueQueueRef.current.push(dialogueItem)
      return
    }
    presentOracleDialogue(dialogueItem)
  }, [presentOracleDialogue, state.activeScene])

  useEffect(() => {
    if (state.activeScene) return
    const nextOracle = oracleDialogueQueueRef.current.shift()
    if (nextOracle) {
      presentOracleDialogue(nextOracle)
    }
    return () => {
      if (oracleDialogueTimerRef.current) clearTimeout(oracleDialogueTimerRef.current)
    }
  }, [state.activeScene, presentOracleDialogue])

  const resolveTradingAgentsScene = useCallback((sceneKey, currentAgentId = null) => {
    const baseScene = STEP_SCENES[sceneKey]
    if (!baseScene) return null

    const scene = cloneSceneConfig(baseScene)
    const phaseOverride = pipelineScenesRef.current[sceneKey] || {}
    const timelineSpec = currentAgentId ? TRADING_AGENT_TIMELINE_SCENE_BY_AGENT[currentAgentId] : null
    const timelineOverride = timelineSpec ? (pipelineScenesRef.current[timelineSpec.key] || {}) : {}
    const featuredAgents = Array.isArray(timelineOverride.agents) && timelineOverride.agents.length > 0
      ? timelineOverride.agents
      : Array.isArray(phaseOverride.agents) && phaseOverride.agents.length > 0
        ? phaseOverride.agents
        : timelineSpec?.agentId
          ? [normalizeTradingAgentName(timelineSpec.agentId) || timelineSpec.agentId]
          : scene.agents
    const phaseAgents = [...new Set((featuredAgents || []).map((agent) => normalizeTradingAgentName(agent) || agent).filter(Boolean))]
    const featuredAgentSet = new Set(phaseAgents)
    const agents = [...TRADING_AGENT_NAMES]

    const resolvedAnimations = {}
    const resolvedStations = {}
    const resolvedPaths = {}

    agents.forEach((agentName) => {
      const agentId = normalizeTradingAgentId(agentName)
      const behavior =
        agentBehaviorDefaultsRef.current[agentName] ||
        agentBehaviorDefaultsRef.current[agentId] ||
        {}

      const phaseAnimation =
        timelineOverride.animations?.[agentName] ||
        timelineOverride.animations?.default ||
        phaseOverride.animations?.[agentName] ||
        phaseOverride.animations?.default ||
        scene.animations?.[agentName] ||
        scene.animations?.default

      const phaseStation =
        timelineOverride.stations?.[agentName] ||
        timelineOverride.stations?.default ||
        phaseOverride.stations?.[agentName] ||
        phaseOverride.stations?.default ||
        scene.stations?.[agentName] ||
        scene.stations?.default ||
        scene.location

      const phasePath =
        timelineOverride.paths?.[agentName] ||
        timelineOverride.paths?.default ||
        phaseOverride.paths?.[agentName] ||
        phaseOverride.paths?.default ||
        scene.paths?.[agentName] ||
        scene.paths?.default

      resolvedAnimations[agentName] = featuredAgentSet.has(agentName)
        ? (phaseAnimation || behavior.default_animation || 'idle')
        : (behavior.default_animation || phaseAnimation || 'idle')

      resolvedStations[agentName] = featuredAgentSet.has(agentName)
        ? (phaseStation || behavior.default_station || scene.location)
        : resolvePassiveTradingAgentStation(agentName, behavior)

      resolvedPaths[agentName] = featuredAgentSet.has(agentName)
        ? (phasePath || behavior.default_path || 'direct')
        : (behavior.default_path || phasePath || 'direct')
    })

    return {
      ...scene,
      ...phaseOverride,
      ...timelineOverride,
      agents,
      activeAgents: phaseAgents,
      location: timelineOverride.location || phaseOverride.location || scene.location,
      animations: resolvedAnimations,
      stations: resolvedStations,
      paths: resolvedPaths,
      timelineSceneKey: timelineSpec?.key || null,
    }
  }, [])

  const buildOrderedLiveDialogue = useCallback((sceneKey, lines) => {
    if (!Array.isArray(lines) || lines.length === 0) return []

    const scene = resolveTradingAgentsScene(sceneKey) || STEP_SCENES[sceneKey]
    const agentOrder = Array.isArray(scene?.agents) ? scene.agents : []
    const orderMap = new Map(agentOrder.map((agent, index) => [normalizeTradingAgentName(agent) || agent, index]))
    const deduped = new Map()

    lines.forEach((line) => {
      const agent = normalizeTradingAgentName(line?.agent) || line?.agent
      const text = typeof line?.text === 'string' ? line.text.trim() : ''
      if (!agent || !text) return
      deduped.set(agent, { agent, text, timestamp: line?.timestamp })
    })

    return [...deduped.values()].sort((a, b) => {
      const aOrder = orderMap.has(a.agent) ? orderMap.get(a.agent) : Number.MAX_SAFE_INTEGER
      const bOrder = orderMap.has(b.agent) ? orderMap.get(b.agent) : Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })
  }, [resolveTradingAgentsScene])

  const hydrateScenePayload = useCallback((scene = {}) => {
    const agents = Array.isArray(scene.agents)
      ? [...new Set(scene.agents.map((agent) => normalizeTradingAgentName(agent) || agent).filter(Boolean))]
      : []
    const dialogue = Array.isArray(scene.dialogue)
      ? scene.dialogue.map((line) => ({
          ...line,
          agent: normalizeTradingAgentName(line.agent) || line.agent,
        }))
      : []
    const stations = { ...(scene.stations || {}), ...(scene.agentStations || {}) }
    const animations = { ...(scene.animations || {}), ...(scene.agentAnimations || {}) }
    const paths = { ...(scene.paths || {}), ...(scene.agentPaths || {}) }
    const agentStations = { ...stations }
    const agentAnimations = { ...animations }
    const agentPaths = { ...paths }

    agents.forEach((agent) => {
      if (!agentStations[agent] && scene.location) {
        agentStations[agent] = stations[agent] || stations.default || scene.location
      }
      if (!agentAnimations[agent]) {
        agentAnimations[agent] = animations[agent] || animations.default || 'idle'
      }
      if (!agentPaths[agent]) {
        agentPaths[agent] = paths[agent] || paths.default || 'direct'
      }
    })

    return {
      ...scene,
      agents,
      dialogue,
      stations,
      animations,
      paths,
      agentStations,
      agentAnimations,
      agentPaths,
    }
  }, [])

  const scenePackageToCommand = useCallback((scene = {}, trigger = 'tradingagents', meta = {}) => {
    const dialogueSource = Array.isArray(scene.lines) && scene.lines.length > 0
      ? scene.lines
      : (Array.isArray(scene.script?.dialogue) ? scene.script.dialogue : [])

    return {
      type: 'PLAY_STEP_SCENE',
      phase: scene.phase,
      ticker: scene.ticker,
      headline: scene.headline,
      state: scene.state,
      agents: scene.active_agents || [],
      dialogue: dialogueSource.map((line) => ({
        agent: normalizeTradingAgentName(line.speaker || line.agent) || line.speaker || line.agent,
        text: line.text,
      })),
      location: scene.station_targets?.[0]?.station || null,
      agentStations: Object.fromEntries((scene.station_targets || []).map((item) => [item.agent, item.station])),
      agentAnimations: Object.fromEntries((scene.animations || []).map((item) => [item.agent, item.animation])),
      agentPaths: scene.agent_paths || {},
      movementPlan: scene.movement_plan || [],
      script: scene.script || {},
      scriptMeta: scene.script_meta || {},
      variant: scene.variant || null,
      runId: meta.run_id || meta.runId || null,
      attempt: meta.attempt ?? null,
      sceneIndex: meta.scene_index ?? null,
      sceneKey: meta.scene_key || scene.script_meta?.scene_key || scene.script?.scene_key || null,
      sceneLabel: meta.scene_label || scene.headline || null,
      sceneKind: meta.scene_kind || null,
      sourceAgent: meta.source_agent || null,
      sourceReportSlot: meta.source_report_slot ?? null,
      trigger,
    }
  }, [])

  const getCanonicalSceneWriterMeta = useCallback((sceneOrCommand = null) => {
    const script = sceneOrCommand?.script || {}
    const scriptMeta = sceneOrCommand?.scriptMeta || sceneOrCommand?.script_meta || {}
    const writerSource = String(
      script.writer_source ?? scriptMeta.writer_source ?? ''
    ).trim().toLowerCase()
    let validationPassed = script.validation_passed
    if (validationPassed === undefined) {
      validationPassed = scriptMeta.validation_passed
    }
    const writerModel = script.writer_model || scriptMeta.writer_model || null
    const sceneLabel = sceneOrCommand?.sceneLabel || sceneOrCommand?.headline || script.scene_label || scriptMeta.scene_label || null
    return {
      writerSource,
      validationPassed,
      writerModel,
      sceneLabel,
    }
  }, [])

  const isLlmValidatedCanonicalScene = useCallback((sceneOrCommand = null) => {
    const writerMeta = getCanonicalSceneWriterMeta(sceneOrCommand)
    return writerMeta.writerSource === 'llm' && writerMeta.validationPassed === true
  }, [getCanonicalSceneWriterMeta])

  const flagCanonicalSceneIntegrityIssue = useCallback((reason, sceneOrCommand = null) => {
    const writerMeta = getCanonicalSceneWriterMeta(sceneOrCommand)
    const message = `Canonical scene rejected (${reason}) | source=${writerMeta.writerSource || '--'} validated=${String(writerMeta.validationPassed)} model=${writerMeta.writerModel || '--'} label=${writerMeta.sceneLabel || '--'}`
    addLog(message)
    setTaRunStats((prev) => ({
      ...prev,
      running: false,
      retrying: false,
      status: 'degraded',
      errorCode: 'SCENE_DIALOGUE_INVALID',
      errorMessage: message,
    }))
  }, [addLog, getCanonicalSceneWriterMeta, setTaRunStats])

  const isCanonicalTradingAgentsSceneCommand = useCallback((sceneCommand = null) => (
    Boolean(
      sceneCommand &&
      (
        sceneCommand.trigger === 'tradingagents-canonical' ||
        sceneCommand.variant === 'TradingAgents Timeline' ||
        sceneCommand.scriptMeta?.timeline_kind
      )
    )
  ), [])

  const getCanonicalSceneCommandKey = useCallback((sceneCommand = null) => {
    if (!sceneCommand) return null
    const runId = sceneCommand.runId || sceneCommand.run_id || sceneCommand.scriptMeta?.run_id || null
    const attempt = Number(sceneCommand.attempt ?? sceneCommand.scriptMeta?.attempt ?? 1)
    const sceneIndex = sceneCommand.sceneIndex ?? sceneCommand.scene_index ?? sceneCommand.scriptMeta?.scene_index
    if (runId && sceneIndex != null) return `${runId}:${attempt}:${sceneIndex}`
    if (runId && sceneCommand.sceneLabel) return `${runId}:${attempt}:${sceneCommand.sceneLabel}`
    return null
  }, [])

  const clearCanonicalScenePlaybackQueue = useCallback(() => {
    canonicalSceneQueueRef.current = []
    activeCanonicalSceneKeyRef.current = null
  }, [])

  const playCanonicalSceneCommand = useCallback((sceneCommand) => {
    const sceneKey = getCanonicalSceneCommandKey(sceneCommand)
    activeCanonicalSceneKeyRef.current = sceneKey
    setActiveScene(sceneCommand)
    window.dispatchEvent(new CustomEvent('SCENE_COMMAND', { detail: sceneCommand }))
  }, [getCanonicalSceneCommandKey, setActiveScene])

  const activateOrQueueCanonicalScene = useCallback((sceneCommand) => {
    if (!sceneCommand) return
    if (!isCanonicalTradingAgentsSceneCommand(sceneCommand)) {
      setActiveScene(sceneCommand)
      window.dispatchEvent(new CustomEvent('SCENE_COMMAND', { detail: sceneCommand }))
      return
    }
    if (!isLlmValidatedCanonicalScene(sceneCommand)) {
      flagCanonicalSceneIntegrityIssue('non_llm_or_not_validated', sceneCommand)
      return
    }

    const sceneKey = getCanonicalSceneCommandKey(sceneCommand)
    if (sceneKey) {
      if (sceneKey === activeCanonicalSceneKeyRef.current) return
      if (canonicalSceneQueueRef.current.some((queuedScene) => getCanonicalSceneCommandKey(queuedScene) === sceneKey)) {
        return
      }
    }

    if (!isCanonicalTradingAgentsSceneCommand(state.activeScene)) {
      playCanonicalSceneCommand(sceneCommand)
      return
    }

    canonicalSceneQueueRef.current = [...canonicalSceneQueueRef.current, sceneCommand]
  }, [
    flagCanonicalSceneIntegrityIssue,
    getCanonicalSceneCommandKey,
    isLlmValidatedCanonicalScene,
    isCanonicalTradingAgentsSceneCommand,
    playCanonicalSceneCommand,
    setActiveScene,
    state.activeScene,
  ])

  const hasCanonicalSceneForRun = useCallback((runId) => {
    if (!runId) return false
    const history = taCanonicalSceneHistoryRef.current[runId]
    return Array.isArray(history) && history.length > 0
  }, [])

  const rememberCanonicalScene = useCallback((payload = {}, scene = null, command = null) => {
    const runId = payload?.active_run_id || payload?.run_id
    if (!runId) return
    const isCanonicalMeta = payload?.scene_index != null || payload?.scene_kind || payload?.source_report_slot != null
    if (isCanonicalMeta) {
      const candidate = command || scene
      if (!candidate || !isLlmValidatedCanonicalScene(candidate)) {
        flagCanonicalSceneIntegrityIssue('history_rejected_non_llm_or_not_validated', candidate)
        return
      }
    }
    const parsedAttempt = Number(payload?.attempt)
    const attempt = Number.isFinite(parsedAttempt) && parsedAttempt > 0 ? parsedAttempt : 1
    const previousAttempt = taCanonicalSceneAttemptRef.current[runId]
    let nextHistory = Array.isArray(taCanonicalSceneHistoryRef.current[runId])
      ? [...taCanonicalSceneHistoryRef.current[runId]]
      : []
    if (previousAttempt != null && previousAttempt !== attempt) {
      nextHistory = []
    }
    taCanonicalSceneAttemptRef.current[runId] = attempt

    const parsedSceneIndex = Number(payload?.scene_index)
    const sceneIndex = Number.isFinite(parsedSceneIndex) ? parsedSceneIndex : null
    const entry = {
      run_id: runId,
      attempt,
      scene_index: sceneIndex,
      scene_label: payload?.scene_label || null,
      scene_kind: payload?.scene_kind || null,
      source_agent: payload?.source_agent || null,
      source_report_slot: payload?.source_report_slot ?? null,
      scene: scene || null,
      command: command || null,
      timestamp: payload?.timestamp || new Date().toISOString(),
    }

    const replaceIndex = sceneIndex == null
      ? -1
      : nextHistory.findIndex((item) => Number(item?.scene_index) === sceneIndex)
    if (replaceIndex >= 0) {
      nextHistory[replaceIndex] = {
        ...nextHistory[replaceIndex],
        ...entry,
      }
    } else {
      nextHistory.push(entry)
    }
    nextHistory.sort((a, b) => {
      const aIndex = Number.isFinite(Number(a?.scene_index)) ? Number(a.scene_index) : Number.MAX_SAFE_INTEGER
      const bIndex = Number.isFinite(Number(b?.scene_index)) ? Number(b.scene_index) : Number.MAX_SAFE_INTEGER
      if (aIndex !== bIndex) return aIndex - bIndex
      return String(a?.timestamp || '').localeCompare(String(b?.timestamp || ''))
    })
    taCanonicalSceneHistoryRef.current[runId] = nextHistory
  }, [flagCanonicalSceneIntegrityIssue, isLlmValidatedCanonicalScene])

  const resetCanonicalSceneHistory = useCallback((runId = null) => {
    if (runId) {
      taCanonicalSceneHistoryRef.current[runId] = []
      delete taCanonicalSceneAttemptRef.current[runId]
      return
    }
    taCanonicalSceneHistoryRef.current = {}
    taCanonicalSceneAttemptRef.current = {}
  }, [])

  const shouldUseSynthTaScene = useCallback((payload = {}) => {
    const hasCanonicalMeta = (
      payload?.scene_index != null ||
      payload?.scene_kind ||
      payload?.source_report_slot != null
    )
    if (hasCanonicalMeta) return false

    // Strict saved-only policy:
    // if no saved pipeline scenes exist, do not synthesize timeline movement.
    const hasSavedPipelineScenes = Object.keys(pipelineScenesRef.current || {}).length > 0
    if (!hasSavedPipelineScenes) return false

    const runId = payload?.active_run_id || payload?.run_id || activeTaRunIdRef.current
    if (!runId) return true

    // Compat mode may not emit canonical scene events; keep canvas movement alive
    // by falling back to synthesized TA scenes until canonical scenes appear.
    return !hasCanonicalSceneForRun(runId)
  }, [hasCanonicalSceneForRun])

  const triggerTradingAgentsScene = useCallback((event) => {
    const agentId = normalizeTradingAgentId(event.current_step || event.agent)
    if (!agentId) return

    const sceneKey = TRADING_AGENT_SCENE_MAP[agentId]
    const sceneConfig = resolveTradingAgentsScene(sceneKey, agentId)
    if (!sceneConfig) return

    const speaker = normalizeTradingAgentName(agentId) || event.agent_display_name || event.agent || 'SYSTEM'
    const scriptSource = stepScript?.phases || stepScript
    const scriptEntry = scriptSource?.[sceneKey]
    const scriptDialogue = scriptEntry?.dialogue
    const scriptHeadline = scriptEntry?.headline
    const isStartScene = event.scene_stage === 'start'
    const backgroundProfiles = taBackgroundProfilesRef.current[sceneKey] || {}
    const cachedForegroundOverride = taForegroundOverrideRef.current[sceneKey]
    const foregroundOverride = cachedForegroundOverride?.agent === speaker
      ? cachedForegroundOverride
      : null
    const liveDialogue = isStartScene
      ? []
      : buildOrderedLiveDialogue(
        sceneKey,
        event.live_dialogue || liveStepDialogueRef.current[sceneKey] || [],
      )
    const dialogueText = isStartScene
      ? (event.raw_excerpt || `${speaker} is working through the current step.`)
      : (
        (typeof event.dialogue === 'string' ? event.dialogue.trim() : '')
        || foregroundOverride?.dialogue
        || event.dialogue_summary
        || ''
      )
    const sceneAgents = Array.isArray(sceneConfig.agents) ? [...sceneConfig.agents] : []
    const agentStations = sceneAgents.reduce((map, agentName) => {
      map[agentName] = sceneConfig.stations?.[agentName] || sceneConfig.location
      return map
    }, {})
    const agentAnimations = sceneAgents.reduce((map, agentName) => {
      const defaultAnimation = sceneConfig.animations?.[agentName] || 'idle'
      const backgroundProfile = backgroundProfiles[agentName]
      let animation = defaultAnimation
      if (backgroundProfile) {
        animation = backgroundProfile.perform === false
          ? defaultAnimation
          : backgroundProfile.animation || defaultAnimation
      }
      if (agentName === speaker && foregroundOverride) {
        animation = foregroundOverride.perform === false
          ? animation
          : (foregroundOverride.animation || animation)
      }
      map[agentName] = animation
      return map
    }, {})

    const agentPaths = sceneAgents.reduce((map, agentName) => {
      const defaultPath = sceneConfig.paths?.[agentName] || 'direct'
      const backgroundProfile = backgroundProfiles[agentName]
      let path = defaultPath
      if (backgroundProfile) {
        path = backgroundProfile.perform === false
          ? 'idle'
          : (backgroundProfile.path || defaultPath)
      }
      if (agentName === speaker && foregroundOverride) {
        path = foregroundOverride.perform === false
          ? path
          : (foregroundOverride.path || path)
      }
      map[agentName] = path
      return map
    }, {})

    let dialoguePayload = []
    if (isStartScene) {
      dialoguePayload = [
        {
          agent: speaker,
          text: dialogueText,
        },
      ]
    } else if (liveDialogue.length > 0) {
      dialoguePayload = liveDialogue
    } else if (dialogueText) {
      dialoguePayload = [
        {
          agent: speaker,
          text: dialogueText,
        },
      ]
    } else if (
      event.useScriptFallback === true
      && Array.isArray(scriptDialogue)
      && scriptDialogue.length > 0
    ) {
      dialoguePayload = scriptDialogue.map((line) => ({
        agent: normalizeTradingAgentName(line.agent) || line.agent,
        text: line.text,
      }))
    }

    const sceneCommand = hydrateScenePayload({
      type: 'PLAY_STEP_SCENE',
      phase: sceneKey,
      agents: sceneAgents,
      location: sceneConfig.location,
      animations: agentAnimations,
      stations: agentStations,
      paths: agentPaths,
      agentStations,
      agentAnimations,
      agentPaths,
      ticker: event.ticker || currentTicker,
      dialogue: dialoguePayload,
      headline: scriptHeadline || sceneConfig.name,
      trigger: 'tradingagents',
      currentStep: agentId,
      highlight: event.highlight || false,
      highlightAgents: event.highlight === false ? [] : [speaker],
    })

    setActiveScene(sceneCommand)

    window.dispatchEvent(new CustomEvent('SCENE_COMMAND', {
      detail: sceneCommand,
    }))
  }, [buildOrderedLiveDialogue, currentTicker, hydrateScenePayload, resolveTradingAgentsScene, setActiveScene, stepScript])

  const rehydrateTradingAgentsScene = useCallback((pipelineStateSnapshot) => {
    const snapshot = pipelineStateSnapshot || {}
    const currentStep = normalizeTradingAgentId(snapshot.current_step || snapshot.agent_display_name)
    if (!currentStep) return
    if (String(snapshot.pipeline_mode || '').toLowerCase() !== 'tradingagents') return

    const sceneKey = TRADING_AGENT_SCENE_MAP[currentStep]
    const liveDialogue = liveStepDialogueRef.current[sceneKey] || []
    const hasLiveDialogue = Array.isArray(liveDialogue) && liveDialogue.length > 0
    const foregroundOverride = taForegroundOverrideRef.current[sceneKey]
    const currentSpeaker = normalizeTradingAgentName(currentStep) || snapshot.agent_display_name
    const matchingForegroundOverride = foregroundOverride?.agent === currentSpeaker
      ? foregroundOverride
      : null

    triggerTradingAgentsScene({
      type: matchingForegroundOverride?.dialogue
        ? 'agent_summary'
        : (hasLiveDialogue ? 'agent_completed' : 'agent_action'),
      current_step: currentStep,
      agent: currentStep,
      agent_display_name: normalizeTradingAgentName(currentStep) || snapshot.agent_display_name,
      ticker: snapshot.ticker || currentTicker,
      live_dialogue: liveDialogue,
      scene_stage: hasLiveDialogue ? 'resume' : 'start',
      raw_excerpt: hasLiveDialogue ? null : `${normalizeTradingAgentName(currentStep) || 'Agent'} is working through the current step.`,
      message: snapshot.action || snapshot.status || 'Working...',
      dialogue: matchingForegroundOverride?.dialogue,
      highlight: true,
    })
  }, [currentTicker, triggerTradingAgentsScene])

  const normalizeTimestamp = (value) => {
    if (!value) return null
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) return null
      const hasExplicitTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed)
      const looksIsoWithoutTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/i.test(trimmed)
      return looksIsoWithoutTimezone && !hasExplicitTimezone ? `${trimmed}Z` : trimmed
    }
    return null
  }

  const resolveStartTime = (payload, fallback = null) => (
    normalizeTimestamp(payload?.start_time || payload?.timestamp || payload?.ts || payload?.time) || fallback
  )

  const buildFreshTaRunStats = (overrides = {}) => ({
    runId: null,
    agentsCompleted: 0,
    agentsTotal: 12,
    completedAgents: {},
    llmCalls: 0,
    toolCalls: 0,
    tokensUp: 0,
    tokensDown: 0,
    tokenTelemetrySeen: false,
    reportsCompleted: 0,
    reportsTotal: 12,
    reports: {},
    reportSectionsCompleted: 0,
    reportSectionsTotal: 12,
    reportSections: {},
    startTime: null,
    endTime: null,
    decision: null,
    elapsed: null,
    running: false,
    completed: false,
    status: 'idle',
    attempt: 1,
    maxAttempts: 1,
    retrying: false,
    invalidAgents: [],
    upstreamGeneratedAt: null,
    ...overrides,
  })

  const extractTokenCounts = (payload = {}) => {
    const usage = payload?.usage || payload?.token_usage || payload?.llm_usage || payload?.analytics || {}
    const pickNumber = (...values) => {
      for (const value of values) {
        const num = Number(value)
        if (Number.isFinite(num)) return num
      }
      return null
    }
    const up = pickNumber(
      payload?.tokens_up,
      payload?.prompt_tokens,
      payload?.input_tokens,
      payload?.tokens_in,
      usage?.tokens_up,
      usage?.prompt_tokens,
      usage?.input_tokens,
      usage?.tokens_in
    )
    const down = pickNumber(
      payload?.tokens_down,
      payload?.completion_tokens,
      payload?.output_tokens,
      payload?.tokens_out,
      usage?.tokens_down,
      usage?.completion_tokens,
      usage?.output_tokens,
      usage?.tokens_out
    )
    const total = pickNumber(
      payload?.total_tokens,
      payload?.tokens,
      usage?.total_tokens,
      usage?.tokens
    )

    if (up == null && down == null && total == null) return null

    return {
      up: up ?? total ?? 0,
      down: down ?? 0,
    }
  }

  const parseTokenLine = (text = '') => {
    if (!text) return null
    const arrowMatch = text.match(/Tokens?:\s*([0-9.,]+)\s*(k?)\s*[↑^]\s*([0-9.,]+)\s*(k?)\s*[↓v]/i)
    if (!arrowMatch) return null
    const toValue = (raw, suffix) => {
      const num = Number(String(raw).replace(/,/g, ''))
      if (!Number.isFinite(num)) return null
      return suffix && suffix.toLowerCase() === 'k' ? num * 1000 : num
    }
    const up = toValue(arrowMatch[1], arrowMatch[2])
    const down = toValue(arrowMatch[3], arrowMatch[4])
    if (up == null || down == null) return null
    return { up, down }
  }

  const hasTokenActivity = (tokenCounts) => (
    Boolean(tokenCounts && (((tokenCounts.up || 0) > 0) || ((tokenCounts.down || 0) > 0)))
  )

  const syncTaRunStatsFromPhase = useCallback((payload, overrides = {}) => {
    const phaseNum = Number(payload?.phase_num || payload?.current_phase || 0)
    if (phaseNum <= 0 && !overrides.force) return

    const nextLlmCalls = Number(payload?.llm_calls)
    const nextToolCalls = Number(payload?.tool_calls)
    const tokenCounts = extractTokenCounts(payload)
    const payloadRunId = payload?.active_run_id || payload?.run_id || null
    const nextAttempt = Number(payload?.attempt)
    const nextMaxAttempts = Number(payload?.max_attempts || payload?.maxAttempts)
    const nextStepId = normalizeTradingAgentId(
      payload?.current_step || payload?.agent || payload?.agent_display_name
    )
    const payloadPhase = String(payload?.phase || payload?.status || '').toUpperCase()
    const payloadStatus = String(payload?.status || '').toUpperCase()
    const isCompletePayload = payloadPhase === 'COMPLETE' || payloadStatus === 'COMPLETE'
    const isFailedPayload = payloadPhase === 'FAILED' || payloadStatus === 'FAILED'
    const isAbortedPayload = payloadPhase === 'ABORTED' || payloadStatus === 'ABORTED'
    const terminalStatus = isCompletePayload
      ? 'complete'
      : isFailedPayload
        ? 'failed'
        : isAbortedPayload
          ? 'aborted'
          : null
    const terminalDecision = isCompletePayload
      ? String(payload?.decision || payload?.action || '').trim().toUpperCase()
      : null

    setTaRunStats((prev) => {
      const runChanged = Boolean(payloadRunId && payloadRunId !== prev.runId)
      const retryRestart =
        !runChanged &&
        overrides.running === true &&
        phaseNum <= 1 &&
        nextStepId === 'market_analyst' &&
        (String(prev.status || '').toLowerCase() === 'retrying' || Array.isArray(prev.invalidAgents) && prev.invalidAgents.length > 0)
      const base = (runChanged || retryRestart)
        ? buildFreshTaRunStats({
          runId: payloadRunId || prev.runId || null,
          attempt: Number.isFinite(nextAttempt) && nextAttempt > 0 ? nextAttempt : (prev.attempt || 1),
          maxAttempts: Number.isFinite(nextMaxAttempts) && nextMaxAttempts > 0 ? nextMaxAttempts : (prev.maxAttempts || (overrides.running ? 3 : 1)),
        })
        : prev
      const resolvedStart = runChanged
        ? resolveStartTime(payload, new Date().toISOString())
        : (base.startTime || resolveStartTime(payload))
      return {
        ...base,
        runId: payloadRunId || base.runId || null,
        startTime: resolvedStart,
        endTime: terminalStatus
          ? normalizeTimestamp(
            payload?.completed_at ||
            payload?.finished_at ||
            payload?.ended_at ||
            payload?.upstream_generated_at ||
            payload?.timestamp
          ) || base.endTime || null
          : null,
        running: terminalStatus ? false : (overrides.running ?? base.running ?? false),
        completed: isCompletePayload ? true : (overrides.running ? false : (base.completed || false)),
        status: terminalStatus || overrides.status || (overrides.running ? 'running' : (base.status || 'idle')),
        retrying: terminalStatus ? false : (overrides.retrying ?? (overrides.running ? false : (base.retrying ?? false))),
        attempt: Number.isFinite(nextAttempt) && nextAttempt > 0 ? nextAttempt : (base.attempt || 1),
        maxAttempts: Number.isFinite(nextMaxAttempts) && nextMaxAttempts > 0 ? nextMaxAttempts : (base.maxAttempts || (overrides.running ? 3 : 1)),
        invalidAgents: retryRestart ? [] : (base.invalidAgents || []),
        llmCalls: Number.isFinite(nextLlmCalls) ? Math.max(base.llmCalls || 0, nextLlmCalls) : base.llmCalls,
        toolCalls: Number.isFinite(nextToolCalls) ? Math.max(base.toolCalls || 0, nextToolCalls) : base.toolCalls,
        tokensUp: tokenCounts ? Math.max(base.tokensUp || 0, tokenCounts.up || 0) : base.tokensUp,
        tokensDown: tokenCounts ? Math.max(base.tokensDown || 0, tokenCounts.down || 0) : base.tokensDown,
        tokenTelemetrySeen: hasTokenActivity(tokenCounts) || Boolean(base.tokenTelemetrySeen),
        agentsCompleted: isCompletePayload ? Math.max(base.agentsCompleted || 0, base.agentsTotal || 12) : (base.agentsCompleted || 0),
        reportSectionsCompleted: isCompletePayload
          ? Math.max(base.reportSectionsCompleted || 0, base.reportSectionsTotal || 12)
          : (base.reportSectionsCompleted || 0),
        reportsCompleted: isCompletePayload
          ? Math.max(base.reportsCompleted || 0, 5)
          : (base.reportsCompleted || 0),
        decision: terminalDecision && !['COMPLETE', 'FAILED', 'ABORTED'].includes(terminalDecision)
          ? terminalDecision
          : base.decision,
      }
    })
  }, [extractTokenCounts, resolveStartTime, setTaRunStats])

  const syncTaRunStatsFromRunRecord = useCallback((run) => {
    if (!run?.run_id) return
    const runStatus = String(run?.run_status || run?.status || '').toUpperCase()
    const isRunningRun = runStatus === 'RUNNING'
    const nextAttempt = Number(run?.attempt || run?.raw_state?.attempt)
    const nextMaxAttempts = Number(run?.max_attempts || run?.raw_state?.max_attempts)
    const tokenCounts = extractTokenCounts({ ...(run?.raw_state || {}), ...run })
    const nextLlmCalls = Number(run?.llm_calls ?? run?.raw_state?.llm_calls)
    const nextToolCalls = Number(run?.tool_calls ?? run?.raw_state?.tool_calls)
    const rawSceneCount = Number(run?.scene_count ?? run?.raw_state?.scene_count)
    const rawLatestSceneIndex = Number(run?.latest_scene_index ?? run?.raw_state?.latest_scene_index)
    const sceneCount = Number.isFinite(rawSceneCount) ? Math.max(0, rawSceneCount) : 0
    const latestSceneIndex = Number.isFinite(rawLatestSceneIndex) ? Math.max(0, rawLatestSceneIndex) : 0
    const reportSectionsProgress = Math.max(
      0,
      Math.min(
        TRADING_AGENT_REPORT_CARD_DEFS.length,
        Math.max(latestSceneIndex, sceneCount > 0 ? sceneCount - 1 : 0)
      )
    )
    const startTime = normalizeTimestamp(
      run?.created_at ||
      run?.start_time ||
      run?.raw_state?.created_at ||
      run?.raw_state?.start_time ||
      run?.timestamp
    ) || new Date().toISOString()

    setTaRunStats((prev) => {
      const runChanged = run.run_id !== prev.runId
      const base = runChanged ? buildFreshTaRunStats() : prev
      return {
        ...base,
        runId: run.run_id,
        startTime: runChanged ? startTime : (base.startTime || startTime),
        endTime: normalizeTimestamp(
          run?.completed_at ||
          run?.finished_at ||
          run?.ended_at ||
          run?.upstream_generated_at ||
          run?.raw_state?.completed_at ||
          run?.raw_state?.finished_at ||
          run?.raw_state?.ended_at ||
          run?.raw_state?.upstream_generated_at
        ) || (isRunningRun ? null : base.endTime || null),
        running: isRunningRun,
        status: isRunningRun ? 'running' : (runStatus ? runStatus.toLowerCase() : base.status),
        retrying: String(base.status || '').toLowerCase() === 'retrying' && isRunningRun,
        attempt: Number.isFinite(nextAttempt) && nextAttempt > 0 ? nextAttempt : (isRunningRun ? 1 : (base.attempt || 1)),
        maxAttempts: Number.isFinite(nextMaxAttempts) && nextMaxAttempts > 0 ? nextMaxAttempts : (isRunningRun ? 3 : (base.maxAttempts || 1)),
        completed: runStatus === 'COMPLETED' ? true : (isRunningRun ? false : base.completed),
        llmCalls: Number.isFinite(nextLlmCalls) ? Math.max(base.llmCalls || 0, nextLlmCalls) : base.llmCalls,
        toolCalls: Number.isFinite(nextToolCalls) ? Math.max(base.toolCalls || 0, nextToolCalls) : base.toolCalls,
        tokensUp: tokenCounts ? Math.max(base.tokensUp || 0, tokenCounts.up || 0) : base.tokensUp,
        tokensDown: tokenCounts ? Math.max(base.tokensDown || 0, tokenCounts.down || 0) : base.tokensDown,
        tokenTelemetrySeen: hasTokenActivity(tokenCounts) || Boolean(base.tokenTelemetrySeen),
        agentsCompleted: reportSectionsProgress > 0
          ? Math.max(base.agentsCompleted || 0, reportSectionsProgress)
          : base.agentsCompleted,
        reportSectionsCompleted: reportSectionsProgress > 0
          ? Math.max(base.reportSectionsCompleted || 0, reportSectionsProgress)
          : base.reportSectionsCompleted,
        reportsCompleted: reportSectionsProgress > 0
          ? Math.max(base.reportsCompleted || 0, Math.min(5, Math.ceil(reportSectionsProgress / 3)))
          : base.reportsCompleted,
        upstreamGeneratedAt:
          run?.upstream_generated_at ||
          run?.raw_state?.upstream_generated_at ||
          base.upstreamGeneratedAt ||
          null,
      }
    })
  }, [extractTokenCounts, setTaRunStats])

  const reconcileTaRunStatsFromPackage = useCallback((pkg) => {
    if (!pkg) return
    const agentReports = Array.isArray(pkg.agent_reports) ? pkg.agent_reports : []
    if (agentReports.length === 0 && !pkg.raw_state) return

    const byAgent = new Map()
    agentReports.forEach((report) => {
      const normalized = normalizeTradingAgentName(report?.agent) || report?.agent
      if (normalized) byAgent.set(normalized, report)
    })

    const completedAgents = {}
    agentReports.forEach((report) => {
      const agentName = normalizeTradingAgentName(report?.agent) || report?.agent
      const agentId = normalizeTradingAgentId(report?.agent) || normalizeTradingAgentId(agentName)
      if (agentId) {
        completedAgents[agentId] = agentName || report?.agent || agentId
      }
    })

    const reportSections = {}
    TRADING_AGENT_REPORT_CARD_DEFS.forEach((reportDef) => {
      const agentId = reportDef.agentId
      const agentName =
        normalizeTradingAgentName(agentId) ||
        TRADING_AGENT_BY_ID[agentId]?.name ||
        agentId
      const agentReport = byAgent.get(normalizeTradingAgentName(agentName) || agentName)
      const storedReport = resolveAgentFullReportText(agentReport)
      const rawText = resolveAgentRawReportText(pkg.raw_state || {}, agentId)
      const fullText =
        (isArchiveReadyReport(rawText) ? rawText : '') ||
        (isArchiveReadyReport(storedReport) ? storedReport : '')
      if (fullText) reportSections[agentId] = true
    })

    setTaRunStats((prev) => {
      const mergedAgents = { ...prev.completedAgents, ...completedAgents }
      const mergedSections = { ...prev.reportSections, ...reportSections }
      const reports = { ...prev.reports }
      TRADING_AGENT_WORKFLOW_STEPS.forEach((step) => {
        const hasAllAgents = step.agents.every((agentId) => mergedSections[agentId])
        if (hasAllAgents) reports[step.reportKey] = true
      })
      return {
        ...prev,
        completedAgents: mergedAgents,
        agentsCompleted: Math.max(prev.agentsCompleted || 0, Object.keys(mergedAgents).length),
        reports,
        reportsCompleted: Math.max(prev.reportsCompleted || 0, Object.keys(reports).length),
        reportSections: mergedSections,
        reportSectionsCompleted: Math.max(
          prev.reportSectionsCompleted || 0,
          Object.keys(mergedSections).length
        ),
        reportsTotal: Math.max(prev.reportsTotal || 0, TRADING_AGENT_REPORT_CARD_DEFS.length),
        reportSectionsTotal: Math.max(prev.reportSectionsTotal || 0, TRADING_AGENT_REPORT_CARD_DEFS.length),
        tokenTelemetrySeen: hasTokenActivity(extractTokenCounts({ ...(pkg?.raw_state || {}), ...pkg })) || Boolean(prev.tokenTelemetrySeen),
      }
    })
  }, [extractTokenCounts, hasTokenActivity, setTaRunStats])

  const buildLiveTaReportsFromPackage = useCallback((pkg) => {
    if (!pkg) return {}
    const agentReports = Array.isArray(pkg.agent_reports) ? pkg.agent_reports : []
    const byAgent = new Map()
    agentReports.forEach((report) => {
      const normalized = normalizeTradingAgentName(report?.agent) || report?.agent
      if (normalized) byAgent.set(normalized, report)
    })

    return TRADING_AGENT_REPORT_CARD_DEFS.reduce((map, reportDef) => {
      const agentId = reportDef.agentId
      const agentName =
        normalizeTradingAgentName(agentId) ||
        TRADING_AGENT_BY_ID[agentId]?.name ||
        agentId
      const agentReport = byAgent.get(normalizeTradingAgentName(agentName) || agentName)
      const storedReport = resolveAgentFullReportText(agentReport)
      const rawText = resolveAgentRawReportText(pkg.raw_state || {}, agentId)
      const fullText =
        (isArchiveReadyReport(rawText) ? rawText : '') ||
        (isArchiveReadyReport(storedReport) ? storedReport : '')
      if (fullText) {
        map[agentId] = {
          text: fullText,
        }
      }
      return map
    }, {})
  }, [])

  const reconcileCompletedPackageLive = useCallback((pkg) => {
    if (!pkg) return

    const runId = pkg?.run_id || null
    const sceneHistory = Array.isArray(pkg?.scene_history) ? pkg.scene_history : []
    const acceptedSceneHistory = []
    if (runId && sceneHistory.length > 0) {
      resetCanonicalSceneHistory(runId)
      sceneHistory.forEach((sceneEntry) => {
        const scenePayload = sceneEntry?.scene || null
        if (!scenePayload || !isLlmValidatedCanonicalScene(scenePayload)) {
          flagCanonicalSceneIntegrityIssue('rehydrate_rejected_non_llm_or_not_validated', scenePayload)
          return
        }
        acceptedSceneHistory.push(sceneEntry)
        rememberCanonicalScene(
          {
            run_id: runId,
            active_run_id: runId,
            attempt: sceneEntry?.attempt,
            scene_index: sceneEntry?.scene_index,
            scene_label: sceneEntry?.scene_label,
            scene_kind: sceneEntry?.scene_kind,
            source_agent: sceneEntry?.source_agent,
            source_report_slot: sceneEntry?.source_report_slot,
            timestamp: sceneEntry?.created_at,
          },
          scenePayload,
          null,
        )
      })
      const latestSceneEntry = acceptedSceneHistory[acceptedSceneHistory.length - 1]
      const latestScene = latestSceneEntry?.scene
      if (latestScene) {
        const sceneCommand = hydrateScenePayload(
          scenePackageToCommand(latestScene, 'tradingagents-canonical', {
            run_id: runId,
            attempt: latestSceneEntry?.attempt,
            scene_index: latestSceneEntry?.scene_index,
            scene_key: latestSceneEntry?.scene_key,
            scene_label: latestSceneEntry?.scene_label,
            scene_kind: latestSceneEntry?.scene_kind,
            source_agent: latestSceneEntry?.source_agent,
            source_report_slot: latestSceneEntry?.source_report_slot,
          })
        )
        rememberCanonicalScene(
          {
            run_id: runId,
            active_run_id: runId,
            attempt: latestSceneEntry?.attempt,
            scene_index: latestSceneEntry?.scene_index,
            scene_label: latestSceneEntry?.scene_label,
            scene_kind: latestSceneEntry?.scene_kind,
            source_agent: latestSceneEntry?.source_agent,
            source_report_slot: latestSceneEntry?.source_report_slot,
            timestamp: latestSceneEntry?.created_at,
          },
          latestScene,
          sceneCommand,
        )
        activateOrQueueCanonicalScene(sceneCommand)
      }
    } else if (
      runId &&
      pkg?.scene &&
      String(pkg?.run_status || pkg?.status || '').toUpperCase() !== 'RUNNING'
    ) {
      const sceneCommand = hydrateScenePayload(
        scenePackageToCommand(pkg.scene, 'tradingagents-canonical', {
          run_id: runId,
          attempt: pkg?.attempt,
          scene_key: pkg?.scene_key || pkg?.scene?.script_meta?.scene_key || null,
          scene_label: pkg?.scene?.headline || null,
          scene_kind: 'latest_run_scene',
        })
      )
      rememberCanonicalScene(
        {
          run_id: runId,
          active_run_id: runId,
          attempt: pkg?.attempt,
          scene_index: null,
          scene_label: pkg?.scene?.headline || null,
          scene_kind: 'latest_run_scene',
          source_agent: null,
          source_report_slot: null,
          timestamp: pkg?.completed_at || pkg?.created_at || new Date().toISOString(),
        },
        pkg.scene,
        sceneCommand,
      )
      activateOrQueueCanonicalScene(sceneCommand)
    }

    const reportMap = buildLiveTaReportsFromPackage(pkg)
    if (Object.keys(reportMap).length > 0) {
      setLiveTaReports((prev) => {
        const next = { ...(prev || {}) }
        Object.entries(reportMap).forEach(([key, entry]) => {
          const resolvedText = typeof entry === 'string' ? entry : entry?.text
          const cleaned = String(resolvedText || '').trim()
          if (!cleaned) return
          if (!isArchiveReadyReport(cleaned)) return
          const existing = next[key] || {}
          next[key] = {
            ...existing,
            key,
            report: cleaned,
            rawText: cleaned,
            reasoning: cleaned,
            timestamp: existing.timestamp || pkg.updated_at || new Date().toISOString(),
          }
        })
        return next
      })
    }

    const agentReports = Array.isArray(pkg.agent_reports) ? pkg.agent_reports : []
    if (agentReports.length > 0) {
      setAgentStates((prev) => {
        const next = { ...(prev || {}) }
        const markCompleted = (key) => {
          if (!key) return
          const existing = next[key]
          next[key] =
            existing && typeof existing === 'object'
              ? { ...existing, status: 'completed' }
              : { status: 'completed' }
        }
        agentReports.forEach((report) => {
          const agentName = normalizeTradingAgentName(report?.agent) || report?.agent
          const agentId = normalizeTradingAgentId(report?.agent) || normalizeTradingAgentId(agentName)
          markCompleted(agentId)
          markCompleted(agentName)
          markCompleted(String(agentName || '').replace(/_/g, ' '))
          markCompleted(String(agentName || '').replace(/\s+/g, '_').toLowerCase())
        })
        return next
      })
    }

    const isCompleted =
      String(pkg?.run_status || pkg?.status || '').toUpperCase() === 'COMPLETED' ||
      Boolean(pkg?.raw_state?.final_trade_decision || pkg?.raw_state?.final_decision)
    if (isCompleted) {
      const finalStepId = 'risk_judge'
      const finalAgentName = normalizeTradingAgentName(finalStepId) || 'Risk Judge'
      const finalTicker = (pkg?.ticker || pkg?.symbol || currentTicker || '').toUpperCase()
      const rawState = pkg?.raw_state || {}
      const packageLlmCalls = Number(
        pkg?.engine_llm_calls ??
        rawState?.engine_llm_calls ??
        pkg?.llm_calls ??
        rawState?.llm_calls
      )
      const packageToolCalls = Number(
        pkg?.engine_tool_calls ??
        rawState?.engine_tool_calls ??
        pkg?.tool_calls ??
        rawState?.tool_calls
      )
      const packageTokens = extractTokenCounts({ ...rawState, ...pkg })
      const completedSectionCount = Math.max(
        Object.keys(reportMap || {}).length,
        agentReports.length,
        TRADING_AGENT_REPORT_CARD_DEFS.length
      )
      const completedAction = String(
        pkg?.recommended_action ||
        pkg?.model_action ||
        rawState?.recommended_action ||
        rawState?.model_action ||
        ''
      ).trim().toUpperCase()
      setPipelineState((prev) => ({
        ...prev,
        pipeline_mode: prev?.pipeline_mode || 'tradingagents',
        active_run_id: runId || prev?.active_run_id,
        run_id: runId || prev?.run_id,
        phase: 'COMPLETE',
        phase_num: 5,
        current_phase: 5,
        status: 'COMPLETE',
        action: completedAction || 'COMPLETE',
        current_step: finalStepId,
        agent_display_name: finalAgentName,
        ticker: finalTicker || prev?.ticker,
        trade_date: pkg?.trade_date || rawState?.trade_date || prev?.trade_date,
        research_depth: pkg?.research_depth || rawState?.research_depth || prev?.research_depth,
        llm_provider: pkg?.llm_provider || rawState?.llm_provider || prev?.llm_provider,
        quick_model: pkg?.quick_model || rawState?.quick_model || prev?.quick_model,
        deep_model: pkg?.deep_model || rawState?.deep_model || prev?.deep_model,
        llm_calls: Number.isFinite(packageLlmCalls) ? packageLlmCalls : prev?.llm_calls,
        tool_calls: Number.isFinite(packageToolCalls) ? packageToolCalls : prev?.tool_calls,
        tokens_in: packageTokens ? packageTokens.up : prev?.tokens_in,
        tokens_out: packageTokens ? packageTokens.down : prev?.tokens_out,
        timestamp:
          pkg?.upstream_generated_at ||
          rawState?.upstream_generated_at ||
          pkg?.completed_at ||
          pkg?.created_at ||
          prev?.timestamp,
      }))
      setTaRunStats((prev) => ({
        ...prev,
        runId: runId || prev.runId,
        running: false,
        completed: true,
        status: 'complete',
        retrying: false,
        endTime:
          pkg?.completed_at ||
          pkg?.finished_at ||
          pkg?.ended_at ||
          pkg?.upstream_generated_at ||
          pkg?.raw_state?.completed_at ||
          pkg?.raw_state?.finished_at ||
          pkg?.raw_state?.ended_at ||
          pkg?.raw_state?.upstream_generated_at ||
          prev.endTime ||
          null,
        decision: completedAction || prev.decision,
        attempt: Number(pkg?.attempt || pkg?.raw_state?.attempt || prev.attempt || 1),
        maxAttempts: Number(pkg?.max_attempts || pkg?.raw_state?.max_attempts || prev.maxAttempts || 1),
        invalidAgents: Array.isArray(pkg?.invalid_agents || pkg?.raw_state?.invalid_agents)
          ? (pkg?.invalid_agents || pkg?.raw_state?.invalid_agents || [])
          : (prev.invalidAgents || []),
        upstreamGeneratedAt: pkg?.upstream_generated_at || pkg?.raw_state?.upstream_generated_at || prev.upstreamGeneratedAt || null,
        llmCalls: Number.isFinite(packageLlmCalls) ? Math.max(prev.llmCalls || 0, packageLlmCalls) : prev.llmCalls,
        toolCalls: Number.isFinite(packageToolCalls) ? Math.max(prev.toolCalls || 0, packageToolCalls) : prev.toolCalls,
        tokensUp: packageTokens ? Math.max(prev.tokensUp || 0, packageTokens.up || 0) : prev.tokensUp,
        tokensDown: packageTokens ? Math.max(prev.tokensDown || 0, packageTokens.down || 0) : prev.tokensDown,
        tokenTelemetrySeen: hasTokenActivity(packageTokens) || Boolean(prev.tokenTelemetrySeen),
        agentsCompleted: Math.max(prev.agentsCompleted || 0, completedSectionCount),
        reportSectionsCompleted: Math.max(prev.reportSectionsCompleted || 0, completedSectionCount),
        reportsCompleted: Math.max(prev.reportsCompleted || 0, 5),
        reportsTotal: Math.max(prev.reportsTotal || 0, TRADING_AGENT_REPORT_CARD_DEFS.length),
        reportSectionsTotal: Math.max(prev.reportSectionsTotal || 0, TRADING_AGENT_REPORT_CARD_DEFS.length),
      }))

      if ((!runId || sceneHistory.length === 0) && shouldUseSynthTaScene({ run_id: runId })) {
        // Fallback only for legacy payloads that do not include canonical timeline scenes.
        rehydrateTradingAgentsScene({
          pipeline_mode: 'tradingagents',
          phase: 'COMPLETE',
          phase_num: 5,
          current_phase: 5,
          status: 'COMPLETE',
          current_step: finalStepId,
          agent_display_name: finalAgentName,
          ticker: finalTicker || currentTicker,
          action: pkg?.recommended_action || pkg?.model_action || 'COMPLETE',
        })
      }
    }

    reconcileTaRunStatsFromPackage(pkg)
  }, [
    activateOrQueueCanonicalScene,
    buildLiveTaReportsFromPackage,
    currentTicker,
    flagCanonicalSceneIntegrityIssue,
    hydrateScenePayload,
    isLlmValidatedCanonicalScene,
    rememberCanonicalScene,
    resetCanonicalSceneHistory,
    scenePackageToCommand,
    shouldUseSynthTaScene,
    rehydrateTradingAgentsScene,
    reconcileTaRunStatsFromPackage,
    setAgentStates,
    setLiveTaReports,
    setPipelineState,
    hasTokenActivity,
    setTaRunStats,
  ])

  const reconciledRunSnapshotRef = useRef({ runId: null, signature: null })
  const reconcileInFlightRef = useRef(false)

  const reconcileFromLatestRun = useCallback(async () => {
    if (reconcileInFlightRef.current) return
    reconcileInFlightRef.current = true
    try {
      const res = await fetch('/api/admin/trading-agents/runs/latest')
      if (!res.ok) return
      const payload = await res.json()
      const latest = payload?.run
      if (!latest?.run_id) return
      const latestStatus = String(latest?.run_status || latest?.status || '').toUpperCase()
      const signature = [
        latest.run_id,
        latestStatus,
        latest.scene_count ?? '',
        latest.latest_scene_index ?? '',
        latest.completed_at ?? '',
        latest.updated_at ?? '',
        latest.llm_calls ?? '',
        latest.tool_calls ?? '',
        latest.tokens_in ?? '',
        latest.tokens_out ?? '',
      ].join('|')
      const isRunningLatest = latestStatus === 'RUNNING'
      if (!isRunningLatest && reconciledRunSnapshotRef.current.signature === signature) return
      const detailRes = await fetch(`/api/admin/trading-agents/runs/${latest.run_id}`)
      const detail = detailRes.ok ? await detailRes.json() : latest
      syncTaRunStatsFromRunRecord(detail)
      reconcileCompletedPackageLive(detail)
      reconciledRunSnapshotRef.current = { runId: latest.run_id, signature }
    } catch {
      // ignore reconciliation failures
    } finally {
      reconcileInFlightRef.current = false
    }
  }, [reconcileCompletedPackageLive, syncTaRunStatsFromRunRecord])

  const clearIdleTradingAgentsLiveState = useCallback(() => {
    activeTaRunIdRef.current = null
    reconciledRunSnapshotRef.current = { runId: null, signature: null }
    liveStepDialogueRef.current = {}
    taBackgroundProfilesRef.current = {}
    taForegroundOverrideRef.current = {}
    clearCanonicalScenePlaybackQueue()

    setLiveTaReports({})
    setActiveScene(null)
    setDialogue(null, null)
    setPipelinePhase('idle')
    setCurrentTicker(null)
    resetTaRunStats()
    setPipelineState((prev) => ({
      ...prev,
      phase: 'IDLE',
      phase_num: 0,
      current_phase: 0,
      active_run_id: null,
      current_step: null,
      agent_display_name: null,
      ticker: null,
      current_ticker: null,
      trade_date: null,
      llm_provider: null,
      quick_model: null,
      deep_model: null,
      action: 'Awaiting engine...',
      status: 'IDLE',
      attempt: 1,
      max_attempts: 1,
    }))
    setAgentStates((prev) => Object.fromEntries(
      Object.entries(prev || {}).map(([name, agent]) => [
        name,
        {
          ...agent,
          status: 'idle',
          decision: null,
          reasoning: null,
          report: null,
          last_action: null,
        },
      ])
    ))
  }, [
    clearCanonicalScenePlaybackQueue,
    resetTaRunStats,
    setActiveScene,
    setAgentStates,
    setCurrentTicker,
    setDialogue,
    setLiveTaReports,
    setPipelinePhase,
    setPipelineState,
  ])

  useEffect(() => {
    const handleCanonicalSceneComplete = (event) => {
      const completedKey = event?.detail?.key || null
      if (
        completedKey &&
        activeCanonicalSceneKeyRef.current &&
        completedKey !== activeCanonicalSceneKeyRef.current
      ) {
        return
      }

      const [nextScene, ...remainingQueue] = canonicalSceneQueueRef.current
      canonicalSceneQueueRef.current = remainingQueue
      if (nextScene) {
        playCanonicalSceneCommand(nextScene)
      }
    }

    window.addEventListener('tradingagents_canonical_scene_complete', handleCanonicalSceneComplete)
    return () => window.removeEventListener('tradingagents_canonical_scene_complete', handleCanonicalSceneComplete)
  }, [playCanonicalSceneCommand])

  const reconcileIdleTradingAgentsState = useCallback((payload = {}) => {
    const phase = String(payload?.phase || payload?.pipeline_state?.phase || '').toUpperCase()
    const pipelineMode = String(payload?.pipeline_mode || payload?.pipeline_state?.pipeline_mode || '').toLowerCase()
    const runId =
      payload?.active_run_id ||
      payload?.run_id ||
      payload?.pipeline_state?.active_run_id ||
      payload?.pipeline_state?.run_id ||
      null

    if (phase !== 'IDLE' || runId) return false
    if (pipelineMode && pipelineMode !== 'tradingagents') return false

    const currentStats = taRunStatsRef.current || {}
    const currentPipeline = pipelineStateRef.current || {}
    const currentStatus = String(currentStats.status || '').toLowerCase()
    const currentPipelineTerminal = [
      String(currentPipeline.phase || '').toUpperCase(),
      String(currentPipeline.status || '').toUpperCase(),
    ].some((value) => ['COMPLETE', 'FAILED', 'ABORTED'].includes(value))
    const hasStickyTerminalRun = Boolean(
      currentStats.runId &&
      !currentStats.running &&
      (
        currentStats.completed === true ||
        ['complete', 'completed', 'failed', 'aborted', 'degraded'].includes(currentStatus) ||
        currentPipelineTerminal
      )
    )
    if (hasStickyTerminalRun) return true

    clearIdleTradingAgentsLiveState()
    return true
  }, [clearIdleTradingAgentsLiveState])

  const syncTaRunStatsFromAgentEvent = useCallback((payload) => {
    const agentId = normalizeTradingAgentId(payload?.current_step || payload?.agent)
    if (!agentId) return

    const nextLlmCalls = Number(payload?.llm_calls)
    const nextToolCalls = Number(payload?.tool_calls)
    const reportKey = TRADING_AGENT_REPORT_KEY_BY_AGENT[agentId]
    const reportSectionKey = agentId
    const payloadRunId = payload?.active_run_id || payload?.run_id || null

    setTaRunStats((prev) => {
      const runChanged = Boolean(payloadRunId && payloadRunId !== prev.runId)
      const base = runChanged ? buildFreshTaRunStats() : prev
      const resolvedStart = runChanged
        ? resolveStartTime(payload, new Date().toISOString())
        : (base.startTime || resolveStartTime(payload))
      const completedAgents = {
        ...base.completedAgents,
        [agentId]: normalizeTradingAgentName(agentId) || agentId,
      }
      const reports = reportKey ? { ...base.reports, [reportKey]: true } : base.reports
      const reportSections = reportSectionKey ? { ...base.reportSections, [reportSectionKey]: true } : base.reportSections
      const completedCount = Object.keys(completedAgents).length

      return {
        ...base,
        runId: payloadRunId || base.runId || null,
        startTime: resolvedStart,
        status: base.status === 'retrying' ? base.status : 'running',
        retrying: base.status === 'retrying' ? true : false,
        completedAgents,
        agentsCompleted: completedCount,
        llmCalls: Number.isFinite(nextLlmCalls)
          ? Math.max(base.llmCalls || 0, nextLlmCalls, completedCount)
          : Math.max(base.llmCalls || 0, completedCount),
        toolCalls: Number.isFinite(nextToolCalls) ? Math.max(base.toolCalls || 0, nextToolCalls) : base.toolCalls,
        reports,
        reportsCompleted: Math.max(base.reportsCompleted || 0, Object.keys(reports).length),
        reportSections,
        reportSectionsCompleted: Math.max(base.reportSectionsCompleted || 0, Object.keys(reportSections || {}).length),
        reportsTotal: Math.max(base.reportsTotal || 0, TRADING_AGENT_REPORT_CARD_DEFS.length),
        reportSectionsTotal: Math.max(base.reportSectionsTotal || 0, TRADING_AGENT_REPORT_CARD_DEFS.length),
      }
    })
  }, [resolveStartTime, setTaRunStats])

  const syncTaRunTelemetry = useCallback((payload) => {
    const nextLlmCalls = Number(payload?.llm_calls)
    const nextToolCalls = Number(payload?.tool_calls)
    const tokenCounts = extractTokenCounts(payload)
    if (!Number.isFinite(nextLlmCalls) && !Number.isFinite(nextToolCalls) && !tokenCounts) return
    const payloadRunId = payload?.active_run_id || payload?.run_id || null

    setTaRunStats((prev) => {
      const runChanged = Boolean(payloadRunId && payloadRunId !== prev.runId)
      const base = runChanged ? buildFreshTaRunStats() : prev
      const nextStats = {
        ...base,
        runId: payloadRunId || base.runId || null,
        startTime: runChanged
          ? resolveStartTime(payload, new Date().toISOString())
          : (base.startTime || resolveStartTime(payload)),
        llmCalls: Number.isFinite(nextLlmCalls) ? Math.max(base.llmCalls || 0, nextLlmCalls) : base.llmCalls,
        toolCalls: Number.isFinite(nextToolCalls) ? Math.max(base.toolCalls || 0, nextToolCalls) : base.toolCalls,
        tokensUp: tokenCounts ? Math.max(base.tokensUp || 0, tokenCounts.up || 0) : base.tokensUp,
        tokensDown: tokenCounts ? Math.max(base.tokensDown || 0, tokenCounts.down || 0) : base.tokensDown,
        tokenTelemetrySeen: hasTokenActivity(tokenCounts) || Boolean(base.tokenTelemetrySeen),
      }
      if (
        !runChanged &&
        nextStats.runId === prev.runId &&
        nextStats.llmCalls === prev.llmCalls &&
        nextStats.toolCalls === prev.toolCalls &&
        nextStats.tokensUp === prev.tokensUp &&
        nextStats.tokensDown === prev.tokensDown &&
        nextStats.tokenTelemetrySeen === prev.tokenTelemetrySeen
      ) {
        return prev
      }
      return nextStats
    })
  }, [extractTokenCounts, hasTokenActivity, resolveStartTime, setTaRunStats])

  const upsertLiveTaReport = useCallback((payload) => {
    const entry = buildLiveTaReportEntry(payload)
    if (!entry) return

    setLiveTaReports((prev) => {
      const existing = (prev || {})[entry.key] || {}
      const preferredText = mergePreferredFullReport(existing.rawText || existing.report || '', entry.rawText || entry.report || '')
      if (!preferredText) return prev || {}
      return {
        ...(prev || {}),
        [entry.key]: {
          ...existing,
          ...entry,
          report: preferredText,
          rawText: preferredText,
          reasoning: preferredText,
        },
      }
    })
  }, [setLiveTaReports])

  const mergeLiveTaSnapshotReports = useCallback((snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return
    setLiveTaReports((prev) => mergeLiveTaReportsFromSnapshot(prev, snapshot))
  }, [setLiveTaReports])

  const applyRuntimeRoomMap = useCallback((mapData, { rerender = true } = {}) => {
    if (!Array.isArray(mapData) || mapData.length === 0 || !Array.isArray(mapData[0])) return false
    const normalized = mapData.map((row) => (Array.isArray(row) ? [...row] : []))
    ROOM_MAP.length = 0
    normalized.forEach((row) => ROOM_MAP.push([...row]))
    window.ROOM_MAP = normalized
    if (window.PHASER_SCENE?.setRoomMap) {
      window.PHASER_SCENE.setRoomMap(normalized)
    }
    if (rerender && window.PHASER_SCENE?.rerenderRoom) {
      window.PHASER_SCENE.rerenderRoom()
    }
    window.dispatchEvent(new CustomEvent('MAP_UPDATED'))
    return true
  }, [])

  const hydrateRuntimeRoomMap = useCallback(async (options = {}) => {
    const res = await fetch('/api/admin/map')
    if (!res.ok) return false
    const data = await res.json()
    return applyRuntimeRoomMap(data, options)
  }, [applyRuntimeRoomMap])

  // ── WebSocket Buffering System ──
  const flushBuffers = useCallback(() => {
    if (window._taUiLogBuffer?.trim()) {
      const lines = window._taUiLogBuffer.trim().split('\n');
      const uniqueLines = [];
      const seenLines = new Set();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!seenLines.has(trimmed)) {
          uniqueLines.push(line);
          seenLines.add(trimmed);
        }
      }
      if (uniqueLines.length > 0) {
        const chunk = uniqueLines.join('\n')
        if (chunk !== lastUiLogChunkRef.current) {
          const cappedChunk = chunk.length > 4000 ? chunk.slice(chunk.length - 4000) : chunk
          addLog('TA', cappedChunk);
          lastUiLogChunkRef.current = cappedChunk
        }
      }
      window._taUiLogBuffer = '';
    }

    if (window._agentStateBuffer && Object.keys(window._agentStateBuffer).length > 0) {
      setAgentStates(prev => {
        let changed = false
        const next = { ...prev }
        for (const [agentName, incoming] of Object.entries(window._agentStateBuffer || {})) {
          const existing = prev?.[agentName] || {}
          const merged = { ...existing, ...incoming }
          if (
            merged.status !== existing.status ||
            merged.decision !== existing.decision ||
            merged.confidence !== existing.confidence ||
            merged.ticker !== existing.ticker ||
            merged.report !== existing.report ||
            merged.reasoning !== existing.reasoning ||
            merged.dialogueSummary !== existing.dialogueSummary ||
            merged.last_action !== existing.last_action
          ) {
            next[agentName] = merged
            changed = true
          }
        }
        return changed ? next : prev
      });
      window._agentStateBuffer = {};
    }

    if (window._pendingTokenTelemetry) {
      const pending = window._pendingTokenTelemetry
      setTaRunStats((prev) => ({
        ...prev,
        tokensUp: Math.max(prev.tokensUp || 0, pending.up || 0),
        tokensDown: Math.max(prev.tokensDown || 0, pending.down || 0),
        tokenTelemetrySeen: Boolean(prev.tokenTelemetrySeen) || Boolean(pending.seen),
      }))
      window._pendingTokenTelemetry = null
    }

    if (window._pendingPipelineState) {
      const ps = window._pendingPipelineState;
      setPipelineState((prev) => {
        const merged = mergePipelineProgress(prev, ps)
        return hasPipelineStateDelta(prev, merged) ? merged : prev
      });
      if (ps.ticker && ps.ticker !== currentTickerRef.current) {
        currentTickerRef.current = ps.ticker
        setCurrentTicker(ps.ticker)
      }
      if (ps.cycle) {
        const nextCycle = Number(ps.cycle)
        if (Number.isFinite(nextCycle) && nextCycle !== cycleRef.current) {
          cycleRef.current = nextCycle
          setCycle(nextCycle)
        }
      }
      window._pendingPipelineState = null;
    }

    if (window._pendingPortfolio) {
      const pending = window._pendingPortfolio;
      setPortfolio(pending.portfolio || {});
      if (pending.analytics) setAnalytics(pending.analytics)
      if (pending.spyBenchmark) setSpyBenchmark(pending.spyBenchmark)
      if (Array.isArray(pending.closedTrades)) setClosedTrades(pending.closedTrades)
      window._pendingPortfolio = null;
    }
  }, [addLog, mergePipelineProgress, hasPipelineStateDelta, rehydrateTradingAgentsScene, setAgentStates, setPipelineState, setPortfolio, setAnalytics, setSpyBenchmark, setClosedTrades])

  const connectWS = useCallback(() => {
    if (unmountedRef.current || wsRef.current || wsProbeRef.current) return
    wsProbeRef.current = true

    backendTargetsRef.current = buildBackendTargets()
    const currentTarget = getCurrentBackendTarget()
    const currentHost = currentTarget?.wsUrl
    if (!currentTarget || !currentHost) {
      wsProbeRef.current = false
      setConnected(false)
      transitionBackendHealth(BACKEND_STATUS.OFFLINE, {
        currentMessage: 'No websocket targets are available.',
        failureReason: 'No websocket targets configured.',
        activeHost: null,
      })
      return
    }

    transitionBackendHealth(
      wsDegradedRef.current || lastGoodHostIndexRef.current !== null
        ? BACKEND_STATUS.RECOVERING
        : BACKEND_STATUS.STARTING,
      {
        activeHost: currentHost,
        currentMessage: `Checking backend readiness before connecting to ${currentTarget.label.toLowerCase()}.`,
      },
    )

    if (!wsDegradedRef.current) {
      console.log(`[App] Connecting to WS: ${currentHost}`);
    }

    const probeBackendReady = async () => {
      try {
        const response = await fetch(currentTarget.probeUrl, { cache: 'no-store' })
        if (response.ok) {
          return { ok: true, reason: null }
        }
        return {
          ok: false,
          reason: `HTTP ${response.status} from ${currentTarget.probeUrl}`,
        }
      } catch (error) {
        return {
          ok: false,
          reason: formatBackendError(error, `Failed to reach ${currentTarget.probeUrl}`),
        }
      }
    }

    const scheduleReconnect = (delay, failureReason) => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      rotateBackendTarget()
      transitionBackendHealth(BACKEND_STATUS.OFFLINE, {
        activeHost: backendTargetsRef.current[wsHostIndexRef.current]?.wsUrl || currentHost,
        currentMessage: `Retry scheduled in ${Math.ceil(delay / 1000)}s.`,
        failureReason,
      })
      reconnectRef.current = setTimeout(connectWS, delay)
    }

    ;(async () => {
      const { ok: backendReady, reason: backendFailureReason } = await probeBackendReady()
      if (!backendReady) {
        wsProbeRef.current = false
        setConnected(false)
        if (!wsDegradedRef.current) {
          console.info('[App] Backend not ready; deferring WS connect.')
          wsDegradedRef.current = true
        }
        transitionBackendHealth(BACKEND_STATUS.OFFLINE, {
          activeHost: currentHost,
          currentMessage: 'Backend readiness probe failed. Trading controls are locked until recovery.',
          failureReason: backendFailureReason,
        })
        scheduleReconnect(3000, backendFailureReason)
        return
      }

      try {
        const ws = new WebSocket(currentHost);
        wsRef.current = ws;
        wsProbeRef.current = false

        ws.onopen = () => {
          console.log(`[App] WS connected: ${currentHost}`);
          wsDegradedRef.current = false
          setConnected(true);
          lastGoodHostIndexRef.current = wsHostIndexRef.current;
          transitionBackendHealth(BACKEND_STATUS.LIVE, {
            activeHost: currentHost,
            currentMessage: `Connected to ${currentTarget.label.toLowerCase()}.`,
          })
          if (reconnectRef.current) {
            clearTimeout(reconnectRef.current);
            reconnectRef.current = null;
          }
          
          // Setup buffer flushing interval
          if (window._flushInterval) clearInterval(window._flushInterval);
          window._flushInterval = setInterval(flushBuffers, 450);
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const incomingRunId = data.active_run_id || data.run_id || null
            const canStartFromPhaseEvent = (
              data.type === 'pipeline_phase' &&
              String(data.pipeline_mode || '').toLowerCase() === 'tradingagents' &&
              Number(data.phase_num || data.current_phase || 0) <= 1
            )
            const canClaimRunId = (
              data.type === 'pipeline_start' ||
              data.type === 'phase_start' ||
              canStartFromPhaseEvent
            )

            if (incomingRunId && canClaimRunId) {
              if (activeTaRunIdRef.current && activeTaRunIdRef.current !== incomingRunId) {
                reconciledRunSnapshotRef.current = { runId: null, signature: null }
              }
              activeTaRunIdRef.current = incomingRunId
            } else if (data.type === 'initial_state' && data.pipeline_state?.active_run_id) {
              activeTaRunIdRef.current = data.pipeline_state.active_run_id
            } else if (data.type === 'initial_state' && reconcileIdleTradingAgentsState(data)) {
              // Backend restarted or finished while this tab stayed open.
            } else if (incomingRunId && !activeTaRunIdRef.current) {
              activeTaRunIdRef.current = incomingRunId
            } else if (
              incomingRunId &&
              activeTaRunIdRef.current &&
              incomingRunId !== activeTaRunIdRef.current &&
              data.type !== 'pipeline_phase'
            ) {
              return
            }
            syncTaRunTelemetry(data)
          
              if (data.type === 'tradingagents_raw_log') {
                const outputStr = data.line || data.message || '';
                if (!outputStr) return;
                if (looksLikePortfolioSnapshotBlock(outputStr)) return;
                const parsedTokens = parseTokenLine(outputStr);
                if (parsedTokens) {
                  const prevPending = window._pendingTokenTelemetry || {}
                  window._pendingTokenTelemetry = {
                    up: Math.max(prevPending.up || 0, parsedTokens.up || 0),
                    down: Math.max(prevPending.down || 0, parsedTokens.down || 0),
                    seen: Boolean(prevPending.seen) || hasTokenActivity(parsedTokens),
                  }
                }
                if (!window._taUiLogBuffer) window._taUiLogBuffer = '';
                window._taUiLogBuffer += outputStr + '\n';
                return;
              }

              if (data.type === 'console_output') {
                const outputStr = data.output || data.message || '';
                if (!outputStr) return;
                if (looksLikePortfolioSnapshotBlock(outputStr)) return;

                const parsedTokens = parseTokenLine(outputStr);
                if (parsedTokens) {
                  const prevPending = window._pendingTokenTelemetry || {}
                  window._pendingTokenTelemetry = {
                    up: Math.max(prevPending.up || 0, parsedTokens.up || 0),
                    down: Math.max(prevPending.down || 0, parsedTokens.down || 0),
                    seen: Boolean(prevPending.seen) || hasTokenActivity(parsedTokens),
                  }
                }
              
                // Filter junk
                const isJunkData = (
                  outputStr.includes('INFO:src.api') ||
                outputStr.includes('INFO:httpx') ||
                outputStr.includes('Broadcasting to') ||
                outputStr.includes('[TA CALLBACK]') ||
                outputStr.includes('HTTP/1.1') ||
                outputStr.includes('Scheduler check') ||
                outputStr.includes('Loaded') ||
                outputStr.includes('WebSocket') ||
                outputStr.includes('voice agents') ||
                outputStr.includes('DataAccess initialized') ||
                outputStr.match(/\[\d{2}:\d{2}:\d{2}\]\s+(INFO|ERROR|WARN)/) ||
                outputStr.includes("{'history':") ||
                outputStr.includes('get_balance_sheet') ||
                outputStr.includes('Processing... Analysis in progress')
              );
            
              if (!isJunkData || outputStr.includes('=====') || window._taPhaseActive) {
                if (!window._taUiLogBuffer) window._taUiLogBuffer = '';
                window._taUiLogBuffer += outputStr + '\n';
              }
              return;
            }

            if (
              data.type === 'agent_research' ||
              data.type === 'agent_action' ||
              data.type === 'agent_decision' ||
              data.type === 'agent_completed' ||
              data.type === 'agent_quality_failed'
            ) {
              const canonicalAgentName = normalizeTradingAgentName(data.agent || data.current_step || data.agent_display_name);
              if (canonicalAgentName) {
                if (!window._agentStateBuffer) window._agentStateBuffer = {};
                const existing =
                  window._agentStateBuffer[canonicalAgentName] ||
                  agentStatesRef.current?.[canonicalAgentName] ||
                  agentStatesRef.current?.[normalizeTradingAgentName(canonicalAgentName)] ||
                  {};
                const candidateReport = extractReportTextPayload(data.report || data.reasoning || data.raw_excerpt || '');
                const existingReport = extractReportTextPayload(existing.report || existing.reasoning || '');
                const isReportReady = data.type === 'agent_completed' ? isDisplayReadyReport(candidateReport) : false;
                const shouldUpgrade =
                  isReportReady &&
                  (reportQualityScore(candidateReport) > reportQualityScore(existingReport));
                const effectiveReport = shouldUpgrade
                  ? candidateReport
                  : (existingReport || '');
                window._agentStateBuffer[canonicalAgentName] = {
                  ...existing,
                  status:
                    data.type === 'agent_completed'
                      ? 'completed'
                      : (data.type === 'agent_quality_failed'
                        ? 'quality_failed'
                        : (data.status || existing.status || 'researching')),
                  decision: data.action || data.decision || existing.decision,
                  confidence: data.confidence ?? existing.confidence,
                  ticker: data.ticker || existing.ticker,
                  report: effectiveReport || existingReport,
                  reasoning: effectiveReport || data.dialogue_summary || existingReport || existing.reasoning,
                  dialogueSummary: data.dialogue_summary || existing.dialogueSummary,
                  last_action: data.action || data.decision || existing.last_action,
                };
              }
              if (data.type === 'agent_completed') {
                const candidateReport = extractReportTextPayload(data.report || data.reasoning || data.raw_excerpt || '');
                upsertLiveTaReport({
                  ...data,
                  report: isDisplayReadyReport(candidateReport) ? candidateReport : (data.report || ''),
                  reasoning: isDisplayReadyReport(candidateReport) ? candidateReport : (data.reasoning || data.raw_excerpt || ''),
                });
              }
            if (
              data.type !== 'agent_completed' &&
              data.type !== 'agent_quality_failed' &&
              !(data.type === 'agent_action' && data.scene_stage === 'start')
            ) return;
          }

          if (data.type === 'agent_summary') {
            const canonicalAgentName = normalizeTradingAgentName(data.agent || data.current_step || data.agent_display_name);
            if (canonicalAgentName) {
              if (!window._agentStateBuffer) window._agentStateBuffer = {};
              const existing =
                window._agentStateBuffer[canonicalAgentName] ||
                agentStatesRef.current?.[canonicalAgentName] ||
                agentStatesRef.current?.[normalizeTradingAgentName(canonicalAgentName)] ||
                {};
              window._agentStateBuffer[canonicalAgentName] = {
                ...existing,
                status: 'completed',
                decision: data.action || data.decision || existing.decision,
                confidence: data.confidence ?? existing.confidence,
                ticker: data.ticker || existing.ticker,
                report: existing.report,
                reasoning: existing.report || existing.reasoning || data.dialogue,
                dialogueSummary: data.dialogue || existing.dialogueSummary,
                last_action: data.action || data.decision || existing.last_action,
              };
            }
          }

          if (data.type === 'portfolio_update') {
            const portfolioPayload = normalizeLivePortfolioPayload(data)
            window._pendingPortfolio = portfolioPayload;
            window.dispatchEvent(new CustomEvent('TRADE_PORTFOLIO_UPDATE', {
              detail: portfolioPayload.snapshot,
            }))
            return;
          }

          if (data.type === 'decision_package_updated') {
            if (data.package) {
              const activeRunId = activeTaRunIdRef.current
              if (!activeRunId || data.package?.run_id === activeRunId) {
                reconcileCompletedPackageLive(data.package)
              }
              if (data.package?.run_id) reconciledRunSnapshotRef.current = { runId: data.package.run_id, signature: null }
              window.dispatchEvent(new CustomEvent('TRADE_DECISION_PACKAGE_UPDATED', {
                detail: data.package,
              }))
            }
            return;
          }

          switch (data.type) {
            case 'initial_state':
              if (data.agent_states || data.agents) {
                const nextAgentStates = data.agent_states || data.agents
                setAgentStates(nextAgentStates);
                mergeLiveTaSnapshotReports(nextAgentStates)
              }
              if (data.portfolio) setPortfolio(data.portfolio);
              if (data.spy_benchmark) setSpyBenchmark(data.spy_benchmark);
              if (data.analytics) setAnalytics(data.analytics);
              if (data.closed_trades?.length > 0) setClosedTrades(data.closed_trades);
              if (data.cycle) setCycle(Number(data.cycle));
              if (data.ticker_queue) setTickerQueue(data.ticker_queue);
              if (data.agent_behavior_defaults || data.pipeline_state?.agent_behavior_defaults) {
                applyAgentBehaviorDefaults(data.agent_behavior_defaults || data.pipeline_state?.agent_behavior_defaults)
              }
              if (data.pipeline_scenes) {
                applyPipelineScenesConfig(data.pipeline_scenes)
              }
              if (data.pipeline_state) {
                const ps = data.pipeline_state;
                applyLiveStepDialogue(ps.live_step_dialogue)
                applyTaBackgroundProfiles(ps.ta_background_profiles)
                applyTaForegroundOverride(ps.ta_foreground_override)
                setPipelineState(prev => mergePipelineProgress(prev, ps));
                if (ps.phase) setPipelinePhase(ps.phase);
                if (ps.ticker) setCurrentTicker(ps.ticker);
                if (ps.cycle) setCycle(Number(ps.cycle));
                if (ps.regime) setRegime(ps.regime);
                if (ps.step_script) setStepScript(ps.step_script)
                if (ps.step_script_meta) setStepScriptMeta(ps.step_script_meta)
                syncTaRunStatsFromPhase(ps, { running: isActiveTradingAgentsPhase(ps) });
                reconcileIdleTradingAgentsState(ps)
                if (
                  String(ps.pipeline_mode || '').toLowerCase() === 'tradingagents' &&
                  (ps.active_run_id || String(ps.phase || '').toUpperCase() === 'COMPLETE')
                ) {
                  reconcileFromLatestRun()
                }
              }
              break;

            case 'pipeline_phase':
              setPipelinePhase(data.phase || 'idle');
              if (data.ticker) setCurrentTicker(data.ticker);
              if (data.cycle) setCycle(Number(data.cycle));
              window._pendingPipelineState = mergePipelineProgress(window._pendingPipelineState, data);
              syncTaRunStatsFromPhase(data, { running: isActiveTradingAgentsPhase(data) });
              reconcileIdleTradingAgentsState(data)
              break;

            case 'pipeline_step_script':
            case 'step_script':
              if (data.script) setStepScript(data.script)
              if (data.meta) setStepScriptMeta(data.meta)
              break;

            case 'pipeline_scenes_updated':
              if (data.config) {
                applyPipelineScenesConfig(data.config)
              }
              break;

            case 'agent_behavior_defaults_updated':
              if (data.agent_behavior_defaults) applyAgentBehaviorDefaults(data.agent_behavior_defaults)
              break;

            case 'phase_background_profiles': {
              const sceneKey = PIPELINE_SCENE_KEY_ALIASES[data.phase] || data.phase
              if (STEP_SCENES[sceneKey] && data.background_profiles) {
                taBackgroundProfilesRef.current = {
                  ...taBackgroundProfilesRef.current,
                  [sceneKey]: normalizeTaBackgroundProfiles(data.background_profiles),
                }
                let normalizedDialogue = []
                if (Array.isArray(data.dialogue_lines) && data.dialogue_lines.length > 0) {
                  const normalizedMap = normalizeLiveDialogueMap({
                    [sceneKey]: data.dialogue_lines,
                  })
                  normalizedDialogue = normalizedMap[sceneKey] || []
                  if (normalizedDialogue.length > 0) {
                    liveStepDialogueRef.current = {
                      ...liveStepDialogueRef.current,
                      [sceneKey]: normalizedDialogue,
                    }
                  }
                }
                const currentStepForScene =
                  normalizeTradingAgentId(window._pendingPipelineState?.current_step) ||
                  normalizeTradingAgentId(data.current_step || data.agent || data.agent_display_name)
                if (
                  currentStepForScene &&
                  TRADING_AGENT_SCENE_MAP[currentStepForScene] === sceneKey &&
                  shouldUseSynthTaScene(data)
                ) {
                  triggerTradingAgentsScene({
                    ...data,
                    current_step: currentStepForScene,
                    agent: currentStepForScene,
                    agent_display_name: normalizeTradingAgentName(currentStepForScene) || data.agent_display_name,
                    live_dialogue: normalizedDialogue,
                    highlight: true,
                  })
                }
              }
              break;
            }

            case 'agent_summary': {
              const sceneKey = TRADING_AGENT_SCENE_MAP[normalizeTradingAgentId(data.current_step || data.agent || data.agent_display_name)]
              const normalizedOverride = normalizeTaForegroundOverride(data)
              if (sceneKey && normalizedOverride) {
                taForegroundOverrideRef.current = {
                  ...taForegroundOverrideRef.current,
                  [sceneKey]: normalizedOverride,
                }
              }
              if (data.live_dialogue) {
                liveStepDialogueRef.current = {
                  ...liveStepDialogueRef.current,
                  ...normalizeLiveDialogueMap({
                    [sceneKey || '']: data.live_dialogue,
                  }),
                }
              }
              if (shouldUseSynthTaScene(data)) {
                triggerTradingAgentsScene(data)
              }
              break;
            }

            case 'tradingagents_scene_history_reset': {
              const runId = data?.active_run_id || data?.run_id || activeTaRunIdRef.current
              resetCanonicalSceneHistory(runId || null)
              clearCanonicalScenePlaybackQueue()
              if (runId && activeTaRunIdRef.current && runId === activeTaRunIdRef.current) {
                setActiveScene(null)
              }
              break
            }

            case 'tradingagents_scene_generated': {
              const scene = data?.scene || null
              if (!scene || !isLlmValidatedCanonicalScene(scene)) {
                flagCanonicalSceneIntegrityIssue('live_event_rejected_non_llm_or_not_validated', scene)
                break
              }
              rememberCanonicalScene(data, scene, null)
              const sceneIndexValue = Number(data?.scene_index ?? scene?.script_meta?.source_report_slot ?? NaN)
              if (Number.isFinite(sceneIndexValue)) {
                const completedFromScenes = Math.max(0, Math.min(12, Math.floor(sceneIndexValue)))
                const sourceAgentId = normalizeTradingAgentId(data?.source_agent)
                setTaRunStats((prev) => {
                  const nextReportSections = { ...(prev.reportSections || {}) }
                  const nextReports = { ...(prev.reports || {}) }
                  if (
                    String(data?.scene_kind || '').toLowerCase() === 'report_completed' &&
                    sourceAgentId
                  ) {
                    nextReportSections[sourceAgentId] = true
                    const reportCardKey = TRADING_AGENT_REPORT_KEY_BY_AGENT[sourceAgentId]
                    if (reportCardKey) nextReports[reportCardKey] = true
                  }
                  return {
                    ...prev,
                    agentsCompleted: Math.max(prev.agentsCompleted || 0, completedFromScenes),
                    reportSections: nextReportSections,
                    reportSectionsCompleted: Math.max(
                      prev.reportSectionsCompleted || 0,
                      completedFromScenes,
                      Object.keys(nextReportSections).length,
                    ),
                    reports: nextReports,
                    reportsCompleted: Math.max(
                      prev.reportsCompleted || 0,
                      Object.keys(nextReports).length,
                    ),
                  }
                })
              }
              if (scene && !data?.command) {
                const fallbackCommand = scenePackageToCommand(scene, 'tradingagents-canonical', {
                  run_id: data?.active_run_id || data?.run_id || null,
                  attempt: data?.attempt,
                  scene_index: data?.scene_index,
                  scene_key: data?.scene_key,
                  scene_label: data?.scene_label,
                  scene_kind: data?.scene_kind,
                  source_agent: data?.source_agent,
                  source_report_slot: data?.source_report_slot,
                })
                const hydratedFallbackCommand = hydrateScenePayload(fallbackCommand)
                activateOrQueueCanonicalScene(hydratedFallbackCommand)
              }
              break
            }

            case 'tradingagents_scene_failed': {
              setTaRunStats((prev) => ({
                ...prev,
                running: false,
                status: 'failed',
                retrying: false,
                attempt: Number(data?.attempt || prev.attempt || 1),
                maxAttempts: Number(data?.max_attempts || data?.maxAttempts || prev.maxAttempts || 1),
              }))
              addMessage({
                ...data,
                type: 'run_failed',
                error_code: data?.error_code || 'SCENE_DIALOGUE_FAILED',
              })
              break
            }

            case 'pipeline_start':
            case 'phase_start':
            case 'phase_completed':
            case 'agent_action':
            case 'agent_completed':
            case 'agent_quality_failed':
            case 'run_retrying':
            case 'tool_call':
            case 'final_decision':
            case 'run_completed':
            case 'run_aborted':
            case 'run_failed':
              if (data.type === 'pipeline_start') {
                resetCanonicalSceneHistory(data?.active_run_id || data?.run_id || null)
                clearCanonicalScenePlaybackQueue()
                if (data.agent_behavior_defaults) applyAgentBehaviorDefaults(data.agent_behavior_defaults)
                if (data.pipeline_scenes) applyPipelineScenesConfig(data.pipeline_scenes)
                applyLiveStepDialogue(data.live_step_dialogue)
                applyTaBackgroundProfiles(data.ta_background_profiles)
                applyTaForegroundOverride(data.ta_foreground_override)
                const runId = data?.active_run_id || data?.run_id || null
                const sceneConfigMissing = Boolean(data?.scene_config_missing)
                if (runId && sceneConfigMissing && !warnedSceneConfigRunsRef.current[runId]) {
                  warnedSceneConfigRunsRef.current[runId] = true
                  addLog(
                    'TA',
                    data?.scene_config_warning ||
                    'Pipeline scenes config is missing. Save scenes in Pipeline Scenes to enable timeline animation/pathfinding.'
                  )
                }
                window._taUiLogBuffer = '';
                window._pendingPipelineState = null;
                window._agentStateBuffer = {};
                setLiveTaReports({});
                setPipelineHistory([{ ...data, timestamp: data.timestamp || new Date().toISOString() }]);
                setActiveScene(null);
                setAgentStates(prev => Object.fromEntries(
                  Object.entries(prev || {}).map(([name, agent]) => [
                    name,
                    { ...agent, status: 'idle', decision: null, reasoning: null, last_action: null },
                  ])
                ));
                resetTaRunStats({
                  runId: data?.active_run_id || data?.run_id || null,
                  running: true,
                  status: 'running',
                  retrying: false,
                  attempt: Number(data?.attempt || 1),
                  maxAttempts: Number(data?.max_attempts || 3),
                  invalidAgents: [],
                  upstreamGeneratedAt: null,
                  startTime: data.start_time || new Date().toISOString(),
                  endTime: null,
                });
              } else {
                addMessage(data);
              }

              if (data.type === 'agent_completed' && data.live_dialogue) {
                liveStepDialogueRef.current = {
                  ...liveStepDialogueRef.current,
                  ...normalizeLiveDialogueMap({
                    [TRADING_AGENT_SCENE_MAP[normalizeTradingAgentId(data.current_step || data.agent)] || '']: data.live_dialogue,
                  }),
                }
              }

              const sceneStage = String(data?.scene_stage || '').toLowerCase()
              const canStartSynthScene = !sceneStage || sceneStage === 'start'
              if (data.type === 'agent_action' && canStartSynthScene && shouldUseSynthTaScene(data)) {
                triggerTradingAgentsScene(data);
              } else if (data.type === 'agent_completed') {
                syncTaRunStatsFromAgentEvent(data);
                if (shouldUseSynthTaScene(data)) {
                  triggerTradingAgentsScene(data);
                }
              } else if (data.type === 'run_retrying') {
                const nextAttempt = Number(data?.attempt || 1)
                const nextMaxAttempts = Number(data?.max_attempts || data?.maxAttempts || 3)
                setTaRunStats((prev) => ({
                  ...prev,
                  running: true,
                  status: 'retrying',
                  retrying: true,
                  attempt: Number.isFinite(nextAttempt) ? nextAttempt : (prev.attempt || 1),
                  maxAttempts: Number.isFinite(nextMaxAttempts) ? nextMaxAttempts : (prev.maxAttempts || 3),
                  invalidAgents: Array.isArray(data?.invalid_agents) ? data.invalid_agents : (prev.invalidAgents || []),
                }))
              } else if (data.type === 'agent_quality_failed') {
                setTaRunStats((prev) => {
                  const current = Array.isArray(prev.invalidAgents) ? [...prev.invalidAgents] : []
                  current.push({
                    agent: data?.agent,
                    agent_display_name: data?.agent_display_name,
                    reason: data?.reason,
                    excerpt: data?.excerpt,
                  })
                  return {
                    ...prev,
                    status: 'quality_failed',
                    invalidAgents: current,
                  }
                })
              } else if (data.type === 'run_completed') {
                activeTaRunIdRef.current = null
                const nextAttempt = Number(data?.attempt || 1)
                const nextMaxAttempts = Number(data?.max_attempts || data?.maxAttempts || 1)
                setTaRunStats(prev => ({
                  ...prev,
                  running: false,
                  completed: true,
                  status: 'complete',
                  retrying: false,
                  attempt: Number.isFinite(nextAttempt) ? nextAttempt : (prev.attempt || 1),
                  maxAttempts: Number.isFinite(nextMaxAttempts) ? nextMaxAttempts : (prev.maxAttempts || 1),
                  invalidAgents: Array.isArray(data?.invalid_agents) ? data.invalid_agents : (prev.invalidAgents || []),
                  upstreamGeneratedAt: data?.timestamp || prev.upstreamGeneratedAt || null,
                  endTime:
                    data?.completed_at ||
                    data?.finished_at ||
                    data?.ended_at ||
                    data?.timestamp ||
                    prev.endTime ||
                    null,
                  agentsCompleted: Math.max(prev.agentsCompleted || 0, prev.agentsTotal || 12),
                  reportSectionsCompleted: Math.max(prev.reportSectionsCompleted || 0, prev.reportSectionsTotal || 12),
                  reportsCompleted: Math.max(prev.reportsCompleted || 0, 5),
                }));
              } else if (data.type === 'run_aborted') {
                activeTaRunIdRef.current = null
                setTaRunStats(prev => ({
                  ...prev,
                  running: false,
                  completed: false,
                  status: 'aborted',
                  retrying: false,
                  endTime: data?.timestamp || prev.endTime || null,
                }));
              } else if (data.type === 'run_failed') {
                activeTaRunIdRef.current = null
                data.status = data.status || 'FAILED';
                data.phase = data.phase || 'FAILED';
                const status = String(data?.error_code || '').toUpperCase() === 'REPORT_QUALITY_FAILED'
                  ? 'quality_failed'
                  : 'failed'
                setTaRunStats(prev => ({
                  ...prev,
                  running: false,
                  completed: false,
                  status,
                  retrying: false,
                  attempt: Number(data?.attempt || prev.attempt || 1),
                  maxAttempts: Number(data?.max_attempts || data?.maxAttempts || prev.maxAttempts || 1),
                  invalidAgents: Array.isArray(data?.invalid_agents) ? data.invalid_agents : (prev.invalidAgents || []),
                }));
              }
              
              if (data.type === 'phase_start') window._taPhaseActive = true;
              if (data.type === 'phase_completed') window._taPhaseActive = false;
              
              window._pendingPipelineState = mergePipelineProgress(window._pendingPipelineState, data);
              break;

            case 'trade_executed':
              addLog('TRADE', `Executed: ${data.side} ${data.amount} ${data.ticker} @ ${data.price}`);
              break;

            case 'oracle_question_answered':
              queueOracleDialogue(data)
              addMessage({
                ...data,
                agent: 'Oracle',
                message: data.answer || data.item?.answer || '',
              })
              break;

            case 'streamed_news': {
              const item = data.data || data.item || data.news || null
              if (item && (item.title || item.text || item.message)) {
                addStreamedNews({
                  ...item,
                  timestamp: item.timestamp || item.published || new Date().toISOString(),
                })
              }
              break;
            }

            case 'LIVE_NEWS_FEED': {
              const articles = Array.isArray(data.data?.articles)
                ? data.data.articles
                : Array.isArray(data.articles)
                  ? data.articles
                  : []
              if (articles.length) {
                appendLiveNews(articles)
                articles.slice(0, 20).forEach((item) => {
                  if (item && (item.title || item.text || item.message)) {
                    addStreamedNews({
                      ...item,
                      timestamp: item.timestamp || item.published || new Date().toISOString(),
                    })
                  }
                })
              }
              break;
            }

            case 'MARQUEE_UPDATE': {
              const text = data.data?.text || data.text || data.message || ''
              if (text) setMarqueeText(String(text))
              break;
            }

            case 'map_updated':
              hydrateRuntimeRoomMap().catch((err) => console.warn('[App] Failed to hydrate map update:', err))
              break

            case 'broadcast_settings':
              if (data.data) {
              if (data.data.marqueeSpeed) setMarqueeSpeed(parseInt(data.data.marqueeSpeed))
              if (data.data.newsScrollSpeed) setNewsScrollSpeed(parseInt(data.data.newsScrollSpeed))
              if (data.data.hideNews !== undefined) setHideNews(data.data.hideNews)
              if (data.data.hideCycle !== undefined) setHideCycle(data.data.hideCycle)
              if (data.data.hideLeftSidebar !== undefined) setHideLeftSidebar(data.data.hideLeftSidebar)
              if (data.data.hideRightSidebar !== undefined) setHideRightSidebar(data.data.hideRightSidebar)
              if (data.data.showPerformanceView !== undefined) setShowPerformanceView(data.data.showPerformanceView)
              if (data.data.lightMode) {
                setLightMode(data.data.lightMode)
                window.dispatchEvent(new CustomEvent('SCENE_COMMAND', { detail: { type: 'SET_LIGHTING', mode: data.data.lightMode } }))
              }
              }
              break;

            case 'scene_command':
              if (data.command) {
                const hydratedCommand = hydrateScenePayload({
                  ...data.command,
                  runId: data.command?.runId || data?.active_run_id || data?.run_id || null,
                  attempt: data.command?.attempt ?? data?.attempt ?? null,
                  sceneIndex: data.command?.sceneIndex ?? data?.scene_index ?? null,
                  sceneKey: data.command?.sceneKey || data?.scene_key || null,
                  sceneLabel: data.command?.sceneLabel || data?.scene_label || null,
                  sceneKind: data.command?.sceneKind || data?.scene_kind || null,
                  sourceAgent: data.command?.sourceAgent || data?.source_agent || null,
                  sourceReportSlot: data.command?.sourceReportSlot ?? data?.source_report_slot ?? null,
                })
                const hasTimelineMeta = data.scene_index != null || data.scene_kind || data.source_report_slot != null
                if (hydratedCommand.movementOnly === true) {
                  window.dispatchEvent(new CustomEvent('SCENE_COMMAND', { detail: hydratedCommand }))
                  break
                }
                if (hasTimelineMeta) {
                  if (!isLlmValidatedCanonicalScene(hydratedCommand)) {
                    flagCanonicalSceneIntegrityIssue('scene_command_rejected_non_llm_or_not_validated', hydratedCommand)
                    break
                  }
                  rememberCanonicalScene(data, null, hydratedCommand)
                  activateOrQueueCanonicalScene(hydratedCommand)
                } else {
                  setActiveScene(hydratedCommand)
                  window.dispatchEvent(new CustomEvent('SCENE_COMMAND', { detail: hydratedCommand }))
                }
              }
              break;

            case 'tradingagents_scene_cue':
              if (data.command) {
                const hydratedCue = hydrateScenePayload({
                  ...data.command,
                  movementOnly: true,
                  runId: data.command?.runId || data?.active_run_id || data?.run_id || null,
                  attempt: data.command?.attempt ?? data?.attempt ?? null,
                  sceneIndex: data.command?.sceneIndex ?? data?.scene_index ?? null,
                  sceneKey: data.command?.sceneKey || data?.scene_key || null,
                  sceneLabel: data.command?.sceneLabel || data?.scene_label || null,
                  sceneKind: data.command?.sceneKind || data?.scene_kind || null,
                  sourceAgent: data.command?.sourceAgent || data?.source_agent || null,
                  sourceReportSlot: data.command?.sourceReportSlot ?? data?.source_report_slot ?? null,
                })
                window.dispatchEvent(new CustomEvent('SCENE_COMMAND', { detail: hydratedCue }))
              }
              break;
          }
        } catch (e) {
          console.warn('WS parse error:', e)
        }
      }

        ws.onclose = (event) => {
          wsProbeRef.current = false
          setConnected(false)
          wsRef.current = null
          if (unmountedRef.current) return
          if (!wsDegradedRef.current) {
            console.info('[App] WS disconnected; entering reconnect mode.')
            wsDegradedRef.current = true
          }
          const closeReason = describeWsCloseEvent(event)
          transitionBackendHealth(BACKEND_STATUS.OFFLINE, {
            activeHost: currentHost,
            currentMessage: 'WebSocket link dropped. Trading controls are locked until the backend reconnects.',
            failureReason: closeReason,
          })
          if (manualReconnectRef.current) {
            manualReconnectRef.current = false
            lastGoodHostIndexRef.current = null
            transitionBackendHealth(BACKEND_STATUS.RECOVERING, {
              activeHost: currentHost,
              currentMessage: 'Manual reconnect requested. Re-establishing backend link.',
              failureReason: closeReason,
            })
            connectWS()
            return
          }
          const delay = lastGoodHostIndexRef.current !== null ? 1500 : 3000;
          scheduleReconnect(delay, closeReason)
        }

        ws.onerror = (error) => {
          const failureReason = formatBackendError(error, 'WebSocket transport error.')
          if (!wsDegradedRef.current) {
            const label = isTransientTransportError(error)
              ? '[App] WS transport unavailable; retrying in degraded mode.'
              : '[App] WS error; retrying in degraded mode.'
            console.info(label)
            wsDegradedRef.current = true
          }
          transitionBackendHealth(BACKEND_STATUS.OFFLINE, {
            activeHost: currentHost,
            currentMessage: 'WebSocket transport error. Trading controls are locked until the backend reconnects.',
            failureReason,
          })
          ws.close()
        };
      } catch (e) {
        wsProbeRef.current = false
        if (!wsDegradedRef.current) {
          const label = isTransientTransportError(e)
            ? '[App] WS connect attempt failed; continuing retry loop.'
            : '[App] WS setup failed; continuing retry loop.'
          console.info(label)
          wsDegradedRef.current = true
        }
        const setupFailureReason = formatBackendError(e, 'WebSocket setup failed.')
        transitionBackendHealth(BACKEND_STATUS.OFFLINE, {
          activeHost: currentHost,
          currentMessage: 'WebSocket setup failed. Trading controls are locked until the backend reconnects.',
          failureReason: setupFailureReason,
        })
        scheduleReconnect(3000, setupFailureReason)
      }
    })()
  }, [flushBuffers, getCurrentBackendTarget, hydrateScenePayload, triggerTradingAgentsScene, resetTaRunStats, setAgentStates, setPortfolio, setPipelineState, setPipelinePhase, setCurrentTicker, setCycle, setTickerQueue, syncTaRunStatsFromAgentEvent, syncTaRunStatsFromPhase, syncTaRunTelemetry, addLog, addMessage, setConnected, setMarqueeSpeed, setNewsScrollSpeed, setHideNews, setHideCycle, setHideLeftSidebar, setHideRightSidebar, setShowPerformanceView, setLightMode, setActiveScene, addStreamedNews, appendLiveNews, setMarqueeText, hydrateRuntimeRoomMap, applyPipelineScenesConfig, applyTaBackgroundProfiles, applyTaForegroundOverride, mergePipelineProgress, setStepScript, setStepScriptMeta, setSpyBenchmark, setAnalytics, setClosedTrades, queueOracleDialogue, setLiveTaReports, transitionBackendHealth, upsertLiveTaReport, mergeLiveTaSnapshotReports, reconcileCompletedPackageLive, rotateBackendTarget, unmountedRef, shouldUseSynthTaScene, resetCanonicalSceneHistory, rememberCanonicalScene, scenePackageToCommand, isLlmValidatedCanonicalScene, flagCanonicalSceneIntegrityIssue])

  useEffect(() => {
    if (!connected) return undefined
    const interval = setInterval(() => {
      const stats = taRunStatsRef.current || {}
      const pipeline = pipelineStateRef.current || {}
      const pipelineStatus = String(pipeline?.status || '').toUpperCase()
      const hasActiveRun = Boolean(pipeline?.active_run_id || stats?.runId)
      const shouldReconcile = hasActiveRun || stats?.running || pipelineStatus === 'RUNNING'
      if (shouldReconcile) {
        reconcileFromLatestRun()
      }
    }, 2500)
    return () => clearInterval(interval)
  }, [connected, reconcileFromLatestRun])

  const forceReconnect = useCallback(() => {
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current)
      reconnectRef.current = null
    }
    backendTargetsRef.current = buildBackendTargets()
    wsHostIndexRef.current = lastGoodHostIndexRef.current ?? 0
    transitionBackendHealth(BACKEND_STATUS.RECOVERING, {
      activeHost: backendTargetsRef.current[wsHostIndexRef.current]?.wsUrl || null,
      currentMessage: 'Manual reconnect requested. Re-establishing backend link.',
    })
    if (wsRef.current) {
      manualReconnectRef.current = true
      wsRef.current.close()
      return
    }
    connectWS()
  }, [connectWS, transitionBackendHealth])

  // Store connectWS in a ref so the effect always calls the latest version
  const connectWSRef = useRef(connectWS)
  useEffect(() => { connectWSRef.current = connectWS }, [connectWS])

  useEffect(() => {
    unmountedRef.current = false
    connectWSRef.current()
    return () => {
      unmountedRef.current = true
      if (wsRef.current) wsRef.current.close()
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (window._flushInterval) clearInterval(window._flushInterval)
    }
  }, [])  // Run once on mount only

  // Poll portfolio REST
  useEffect(() => {
    if (!connected) return undefined
    const poll = async () => {
      try {
        const res = await fetchPortfolio()
        if (res?.portfolio) {
          setPortfolio({
             ...res.portfolio,
             position_details: res.position_details,
             position_tracker: res.position_tracker,
             trade_history: res.trade_history,
             analytics: res.analytics || res.portfolio?.analytics,
             closed_trades: res.closed_trades || res.portfolio?.closed_trades || [],
          })
        }
        if (res?.spy_benchmark) setSpyBenchmark(res.spy_benchmark)
        if (res?.analytics) setAnalytics(res.analytics)
        if (res?.execution_history) setExecutionHistory(res.execution_history)
        if (res?.closed_trades?.length > 0) setClosedTrades(res.closed_trades)
      } catch { }
    }
    poll()
    const iv = setInterval(poll, 15000)
    return () => clearInterval(iv)
  }, [connected, setPortfolio, setSpyBenchmark, setAnalytics, setExecutionHistory, setClosedTrades])

  // Check current mode on load
  useEffect(() => {
    if (!connected) return
    fetch('/trading-floor/mode')
      .then(r => r.json())
      .then(d => {
        if (d.mode && d.mode !== 'stopped') setMode(d.mode)
      })
      .catch(() => { })
  }, [connected])

  // Load persistent map on startup
  useEffect(() => {
    if (!connected) return
    hydrateRuntimeRoomMap()
      .catch(e => console.warn("No persistent map found:", e));
  }, [connected, hydrateRuntimeRoomMap]);

  // Seed pipeline state on load
  useEffect(() => {
    const loadFlowState = async () => {
      if (!connected) return
      try {
        const res = await fetch('/trading-floor/flow/state')
        if (!res.ok) return
        const data = await res.json()
        if (data.phase) setPipelinePhase(data.phase)
        if (data.ticker) setCurrentTicker(data.ticker)
        if (data.cycle) setCycle(Number(data.cycle))
        if (data.regime) setRegime(data.regime)
        if (data.agent_states) {
          setAgentStates(data.agent_states)
          mergeLiveTaSnapshotReports(data.agent_states)
        }
        reconcileIdleTradingAgentsState(data)
        if (
          String(data.pipeline_mode || '').toLowerCase() === 'tradingagents' &&
          (data.active_run_id || String(data.phase || '').toUpperCase() === 'COMPLETE')
        ) {
          reconcileFromLatestRun()
        }
      } catch { }
    }
    loadFlowState()
  }, [connected, setAgentStates, setPipelinePhase, setCurrentTicker, setCycle, setRegime, mergeLiveTaSnapshotReports, reconcileFromLatestRun, reconcileIdleTradingAgentsState])
  
  useEffect(() => {
    refreshAgents().then(success => {
      if (success) console.log('[App] Global agents unified')
    })
  }, [refreshAgents])

  const switchMode = async (newMode) => {
    try {
      await fetch(`/trading-floor/mode/${newMode === null ? 'stopped' : newMode}`, { method: 'POST' })
    } catch { }
    if (newMode === null) {
      setMode(null)
      navigate('/floor')
    } else if (newMode === 'automatic') {
      setMode('automatic')
      navigate('/floor')
    } else if (newMode === 'manual') {
      setMode('manual')
      navigate('/')
    }
  }

  const sharedProps = {
    connected, messages, agentStates, portfolio, spyBenchmark,
    cycle, currentTicker, pipelinePhase, regime, premortemData,
    warRoomBrief, stepScript, stepScriptMeta, queue, tickerQueue, pipelineHistory,
    closedTrades, mode, switchMode, forceReconnect,
    zoneEvents, marqueeSpeed, newsScrollSpeed, hideNews, hideCycle,
    hideLeftSidebar, hideRightSidebar, showPerformanceView, lightMode, schedulePhase,
    analytics, backendHealth,
    agents, agentNameMap,
    setAgentStates, setPortfolio, setSpyBenchmark,
    setAnalytics, setClosedTrades, setZoneEvents,
    setMarqueeSpeed, setNewsScrollSpeed, setHideNews, setHideCycle,
    setHideLeftSidebar, setHideRightSidebar, setShowPerformanceView, setLightMode, setSchedulePhase,
    broadcastUISettings
  }

  const showBackendOverlay =
    isBackendShellPath(location.pathname) &&
    !connected &&
    (
      backendHealth?.status === BACKEND_STATUS.OFFLINE ||
      backendHealth?.status === BACKEND_STATUS.RECOVERING
    )

  return (
    <>
      <Routes>
        <Route path="/" element={<TradingFloorPage mode="obs" {...sharedProps} />} />
        <Route path="/admin" element={<AdminOverlayPage {...sharedProps} />} />
        <Route path="/admin/god" element={<Navigate to="/admin" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {showBackendOverlay ? (
        <BackendOfflineOverlay backendHealth={backendHealth} onReconnect={forceReconnect} />
      ) : null}
    </>
  );
}
