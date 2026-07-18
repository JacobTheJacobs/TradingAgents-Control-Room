import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTradingFloor } from '../../../context/TradingFloorContext'
import {
  FaArrowDown,
  FaArrowUp,
  FaBalanceScale,
  FaBolt,
  FaChartBar,
  FaClipboardList,
  FaFileAlt,
  FaGavel,
  FaLock,
  FaRegNewspaper,
  FaRegSmile,
  FaShieldAlt,
} from 'react-icons/fa'
import { GiBroadsword } from 'react-icons/gi'
import {
  compactRunText,
  getRunTimestampMs,
  getDecisionSummary,
  getRunActionLabel,
  isLegacyTradingAgentsRun,
  isCompletedTradingAgentsRun,
  selectLatestCompletedRun,
  standardizeAction,
  TRADE_DECISION_EVENT,
} from '../../../utils/tradingAgentRuns'
import {
  TRADING_AGENT_BY_ID,
  TRADING_AGENT_REPORT_CARD_DEFS,
  TRADING_AGENT_REPORT_CARD_BY_SLOT,
  TRADING_AGENT_WORKFLOW_STEP_BY_NUMBER,
  getTradingAgentRawStateReportValues,
  normalizeTradingAgentId,
  normalizeTradingAgentName,
} from '../../../config/tradingAgentsRoster'

const RUNS_API_BASE = '/api/admin/trading-agents/runs'

/**
 * High-Fidelity Tactical Icons (Abstract Intelligence)
 * Matches the reference image's professional readout style
 */
const TACTICAL_SUMMARY_ICON_BY_AGENT = {
  market_analyst: FaChartBar,
  social_analyst: FaRegSmile,
  news_analyst: FaRegNewspaper,
  fundamentals_analyst: FaClipboardList,
  bull_researcher: FaArrowUp,
  bear_researcher: FaArrowDown,
  research_manager: FaShieldAlt,
  trader: FaBolt,
  aggressive_analyst: GiBroadsword,
  conservative_analyst: FaLock,
  neutral_analyst: FaBalanceScale,
  risk_judge: FaGavel,
}

const TAB_TO_REPORT_KEY = {
  showrunner: 'market_analyst',
  trade: 'trader',
  runs: 'research_manager',
  broadcast: 'news_analyst',
  'pipeline scenes': 'neutral_analyst',
  'final reports': 'risk_judge',
}

const TacticalSummaryIcon = ({ sectionKey, isFinal = false }) => {
  const Icon = TACTICAL_SUMMARY_ICON_BY_AGENT[sectionKey] || FaFileAlt
  const isFinalIcon = sectionKey === 'risk_judge' || isFinal

  return (
    <div className="tactical-summary-icon">
      <Icon
        className={`tactical-summary-icon__glyph${isFinalIcon ? ' is-final' : ''}`}
        aria-hidden="true"
      />
    </div>
  );
};


const readJsonSafely = async (response) => {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const isTransientTransportError = (error) => {
  const message = String(error?.message || error || '')
  return (
    /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION_REFUSED|ERR_ABORTED|aborted|fetch/i.test(message) ||
    error?.name === 'AbortError'
  )
}

const getActionTone = (action) => {
  const normalized = String(action || '').toUpperCase()
  if (normalized === 'BUY' || normalized === 'ADD') return 'buy'
  if (normalized === 'SELL' || normalized === 'LIQUIDATE') return 'sell'
  if (normalized === 'HOLD') return 'hold'
  return 'neutral'
}

const inferActionFromText = (value = '') => {
  const text = String(value || '').toUpperCase()
  if (!text.trim()) return ''
  if (/\b(SELL|LIQUIDATE|REDUCE|TRIM|EXIT)\b/.test(text)) return 'SELL'
  if (/\b(BUY|ADD|LONG|ACCUMULATE|INCREASE)\b/.test(text)) return 'BUY'
  if (/\bHOLD\b/.test(text)) return 'HOLD'
  return ''
}



const stripMetaTokens = (value) => {
  return String(value || '')
    .replace(/\{\s*"name"\s*:[\s\S]*?\}/gi, ' ') // Strip JSON tool calls
    .replace(/\{\s*"thought"\s*:[\s\S]*?\}/gi, ' ') // Strip thought blocks
    .replace(/\{\s*"parameters"\s*:[\s\S]*?\}/gi, ' ')
    .replace(/TRADINGAGENTS[_\s-]*ANALYSIS[_\s-]*COMPLETE[_A-Z0-9_]*\b/gi, ' ')
    .replace(/\bANALYSIS[_\s-]*COMPLETE[_A-Z0-9_]*\b/gi, ' ')
    .replace(/EXECUTIVE SUMMARY\s*(BUY|SELL|HOLD|ADD|REDUCE|TRIM|LIQUIDATE)\b/gi, 'Executive Summary')
    .replace(/\s+/g, ' ')
    .trim()
}

const stripMetaTokensMultiline = (value) => {
  return String(value || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\{\s*"name"\s*:[\s\S]*?\}/gi, '') // Strip JSON tool calls
    .replace(/\{\s*"thought"\s*:[\s\S]*?\}/gi, '') // Strip thought blocks
    .replace(/\{\s*"parameters"\s*:[\s\S]*?\}/gi, '')
    .replace(/TRADINGAGENTS[_\s-]*ANALYSIS[_\s-]*COMPLETE[_A-Z0-9_]*\b/gi, '')
    .replace(/\bANALYSIS[_\s-]*COMPLETE[_A-Z0-9_]*\b/gi, '')
    .replace(/EXECUTIVE SUMMARY\s*(BUY|SELL|HOLD|ADD|REDUCE|TRIM|LIQUIDATE)\b/gi, 'Executive Summary')
    .replace(/^```[a-z0-9_-]*\s*$/gim, '')
    .replace(/^```\s*$/gim, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const stripCliBanner = (text = '') => {
  if (!text) return ''
  const lines = String(text).split('\n')
  const filtered = lines
    .map((line) => line.replace(/[╭╮╯╰│]/g, ' ').replace(/[─]+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false
      if (/TradingAgents:|Multi-Agents LLM Financial Trading Framework|Workflow Steps|Announcements|Step\s+\d:/i.test(line)) return false
      if (/Select Output Language|Select Your|Select your LLM Provider|Default:|You selected|Welcome to TradingAgents|Progress|Messages & Tools/i.test(line)) return false
      if (/^\s*\[.*\]:\s*$/.test(line)) return false
      return true
    })
  return filtered.join('\n').trim()
}

const stripEmoji = (value) => String(value || '')
  .replace(/\p{Extended_Pictographic}/gu, '')
  .replace(/[•✅❌🔴🟢🟡🟠🟣]/g, '')
  .trim()

const stripMarkdownHeading = (value = '') =>
  String(value).replace(/^\s{0,3}#{1,6}\s*/g, '')

const stripInlineFormatting = (value = '') =>
  String(value)
    .replace(/`+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')

const isSeparatorLine = (value = '') => {
  const trimmed = String(value).trim()
  if (!trimmed) return false
  if (/^[-_]{3,}$/.test(trimmed)) return true
  if (/^={3,}$/.test(trimmed)) return true
  if (/^[\-\s]+$/.test(trimmed) && /-/.test(trimmed)) return true
  return false
}

const isTableDividerLine = (value = '') => {
  const trimmed = String(value).trim()
  if (!trimmed || !trimmed.includes('|')) return false
  return /^[\|\s:-]+$/.test(trimmed) && /-/.test(trimmed)
}

const splitTableRow = (value = '') => {
  const trimmed = String(value).trim()
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return withoutEdges.split('|').map((cell) => cell.trim())
}

const formatTableCell = (header = '', cell = '', index = 0) => {
  const trimmedCell = String(cell || '').trim()
  if (!trimmedCell) return ''
  const normalizedHeader = String(header || '').trim()
  const headerLower = normalizedHeader.toLowerCase()
  if (index === 0 || !normalizedHeader) return trimmedCell
  if (/core\s*position|position/.test(headerLower)) return trimmedCell
  if (/analyst|agent/.test(headerLower)) return trimmedCell
  if (/strength/.test(headerLower)) return `Strengths: ${trimmedCell}`
  if (/limitation|weakness|risk/.test(headerLower)) return `Limits: ${trimmedCell}`
  const label = normalizedHeader
    .replace(/\bkey\b/gi, '')
    .replace(/\bcore\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return label ? `${label}: ${trimmedCell}` : trimmedCell
}

const flattenMarkdownTables = (lines = []) => {
  const output = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const next = lines[i + 1]
    if (line && line.includes('|') && next && isTableDividerLine(next)) {
      const headers = splitTableRow(line).map(stripInlineFormatting).map(stripMarkdownHeading)
      i += 2
      while (i < lines.length) {
        const row = lines[i]
        if (!row || !row.includes('|')) break
        if (isTableDividerLine(row)) {
          i += 1
          continue
        }
        const cells = splitTableRow(row).map(stripInlineFormatting)
        const formattedCells = cells
          .map((cell, idx) => formatTableCell(headers[idx], cell, idx))
          .filter(Boolean)
        if (formattedCells.length > 0) {
          output.push(formattedCells.join(' | '))
        }
        i += 1
      }
      continue
    }
    output.push(line)
    i += 1
  }
  return output
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

const isLikelyToolNoise = (value = '') => {
  const text = String(value || '')
  if (!text.trim()) return true
  if (/<tool_call>|<\/tool_call>|[\"'](?:name|parameters|arguments|args)[\"']\s*:/i.test(text)) return true
  return /i[’']?ll\s+try|i[’']?ll\s+try\s+a\s+different|let\s+me\s+correct|let\s+me\s+proceed|i(?:'|’)ll\s+now|i[’']?ll\s+help\s+you\s+conduct/i.test(text)
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

const scoreReportCandidate = (value = '') => {
  const text = String(value || '').trim()
  if (!text) return 0
  if (isLikelyToolNoise(text)) return 0
  let score = text.length
  if (/action\s+plan|executive\s+summary/i.test(text)) score += 200
  if ((text.match(/\n/g) || []).length >= 4) score += 50
  if (/^\s*(?:[-*•]|\d+\.)\s+/m.test(text)) score += 50
  return score
}

const extractReportText = (value, options = {}, seen = new WeakSet()) => {
  const { includeSummary = false } = options

  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()

  if (Array.isArray(value)) {
    const candidates = value
      .map((item) => extractReportText(item, options, seen))
      .filter(Boolean)
    if (candidates.length === 0) return ''
    let best = ''
    let bestScore = 0
    candidates.forEach((candidate) => {
      const score = scoreReportCandidate(candidate)
      if (score > bestScore) {
        bestScore = score
        best = candidate
      }
    })
    if (bestScore > 0 && best) return best.trim()
    return ''
  }

  if (typeof value !== 'object') return ''
  if (seen.has(value)) return ''
  seen.add(value)

  const candidateKeys = includeSummary ? [...REPORT_TEXT_KEYS, 'summary'] : REPORT_TEXT_KEYS
  for (const key of candidateKeys) {
    const nested = extractReportText(value[key], options, seen)
    if (nested) return nested
  }

  return ''
}

const resolveAgentRawStateReportText = (rawState = {}, agentId = '') => {
  if (!rawState || !agentId) return ''
  const values = getTradingAgentRawStateReportValues(rawState, agentId)
  if (!Array.isArray(values) || values.length === 0) return ''
  return extractReportText(values)
}

const resolveAgentStoredFullReportText = (report) => extractReportText(
  report?.display_report ||
  report?.canonical_report ||
  report?.report ||
  report?.reasoning ||
  report?.text ||
  report?.dialogue
)

const normalizeFinalReportText = (value = '') => {
  const cleaned = stripCliBanner(stripMetaTokensMultiline(extractReportText(value, { includeSummary: false }) || value))
  if (!cleaned) return ''
  const baseLines = cleaned.split('\n').map((line) => line.replace(/\r/g, ''))
  const flattened = flattenMarkdownTables(baseLines)
  const normalized = flattened
    .map((line) => stripInlineFormatting(stripMarkdownHeading(line)))
    .map((line) => line.replace(/\s+\|\s+/g, ' | ').replace(/\s{2,}/g, ' ').trim())
    .filter((line) => {
      if (!line) return false
      if (isSeparatorLine(line)) return false
      if (isTableDividerLine(line)) return false
      if (/^<\/?tool_call>$/i.test(line)) return false
      if (/^\s*[\{\}\[\]]\s*$/.test(line)) return false
      if (/[\"'](name|parameters)[\"']\s*:/i.test(line)) return false
      if (/^\{.*\}$/.test(line) && /"[A-Za-z0-9_ ]+"\s*:/.test(line)) return false
      if (/^\[.*\]$/.test(line) && /"[A-Za-z0-9_ ]+"\s*:/.test(line)) return false
      if (/^\s*["'][^"']+["']\s*:/.test(line)) return false
      return true
    })
  return normalized.join('\n').trim()
}

/* ── Report structure extraction helpers ── */
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

const isDisplayReadyReport = (value = '') => {
  const raw = String(value || '')
  const cleaned = normalizeFinalReportText(raw)
  if (!cleaned) return false
  if (isHeaderOnlyReport(cleaned)) return false
  const sentenceCount = (cleaned.match(/[.!?]/g) || []).length
  const lineBreaks = (cleaned.match(/\n/g) || []).length
  if (/<tool_call>|<\/tool_call>|[\"'](?:name|parameters|arguments|args)[\"']\s*:/i.test(raw) || isLikelyToolNoise(raw)) return false
  if (looksLikeDraftScaffold(cleaned)) return false
  if (cleaned.length < 80 && !/^\s*(?:[-*•]|\d+\.)\s+/m.test(cleaned) && lineBreaks < 1 && sentenceCount < 1) return false
  return true
}

const isArchiveReadyReport = (value = '') => {
  const raw = String(value || '')
  const cleaned = normalizeFinalReportText(raw)
  if (!cleaned) return false
  if (isHeaderOnlyReport(cleaned)) return false
  const lineBreaks = (cleaned.match(/\n/g) || []).length
  const sentenceCount = (cleaned.match(/[.!?]/g) || []).length
  if (/<tool_call>|<\/tool_call>|[\"'](?:name|parameters|arguments|args)[\"']\s*:/i.test(raw) || isLikelyToolNoise(raw)) return false
  if (looksLikeDraftScaffold(cleaned)) return false
  if (cleaned.length < 80 && !/^\s*(?:[-*•]|\d+\.)\s+/m.test(cleaned) && lineBreaks < 1 && sentenceCount < 1) return false
  return true
}

const normalizeRuntimeCardStatus = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase()
  if (['completed', 'complete'].includes(normalized)) return 'complete'
  if (['working', 'researching', 'running', 'active'].includes(normalized)) return 'running'
  return 'pending'
}

const normalizeSectionHeading = (value = '') =>
  String(value)
    .replace(/^[#>*\-\s]+/, '')
    .replace(/[:\-]+$/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const extractReportSection = (raw, headings = [], stopHeadings = []) => {
  const text = stripMetaTokensMultiline(raw)
  if (!text) return ''

  const lines = text.split('\n')
  const headingSet = new Set(headings.map(normalizeSectionHeading))
  const stopSet = new Set(stopHeadings.map(normalizeSectionHeading))

  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (headingSet.has(normalizeSectionHeading(lines[i]))) {
      start = i
      break
    }
  }

  if (start === -1) return ''

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const normalized = normalizeSectionHeading(lines[i])
    if (stopSet.has(normalized)) {
      end = i
      break
    }
  }

  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
}

const extractReportPrelude = (raw, stopHeadings = []) => {
  const text = normalizeFinalReportText(raw)
  if (!text) return ''

  const lines = text.split('\n')
  const stopSet = new Set(stopHeadings.map(normalizeSectionHeading))
  let end = lines.length

  for (let i = 0; i < lines.length; i += 1) {
    if (stopSet.has(normalizeSectionHeading(lines[i]))) {
      end = i
      break
    }
  }

  return lines
    .slice(0, end)
    .join('\n')
    .trim()
}

const toTerminalLines = (raw, options = {}) => {
  const { ignoredHeadings = [], maxLines = null } = options
  const ignoredSet = new Set([
    'executive summary',
    'summary of key arguments',
    'action plan',
    ...ignoredHeadings.map(normalizeSectionHeading),
  ])

  const lines = normalizeFinalReportText(raw)
    .split('\n')
    .map((line) =>
      stripEmoji(
        String(line)
          .replace(/^\s*[*\-•]+\s*/, '')
          .replace(/^\s*\d+\.\s*/, '')
          .replace(/\*\*/g, '')
          .trim()
      )
    )
    .filter((line) => {
      const normalized = normalizeSectionHeading(line)
      if (!normalized) return false
      return !ignoredSet.has(normalized)
    })
  if (Number.isFinite(maxLines)) {
    return lines.slice(0, maxLines)
  }
  return lines
}

const buildTerminalItemsFromLines = (lines = []) =>
  lines
    .filter(Boolean)
    .map((text, index) => ({
      label: `${index + 1}`,
      text,
    }))

const toFiniteNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const normalized = value.replace(/[%,$\s]/g, '').replace(/^\+/, '')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

const toDisplayMetric = (value) => {
  const text = String(value || '').trim()
  if (!text || text === '--') return ''
  return text.replace(/^\+/, '')
}

const formatSummaryStatus = (status = '') => {
  switch (String(status || '').toLowerCase()) {
    case 'complete':
      return 'RECEIVED'
    case 'active':
      return 'ANALYZING'
    case 'retrying':
      return 'RETRYING'
    case 'quality_failed':
      return 'FAILED'
    case 'missing':
      return 'MISSING'
    default:
      return 'AWAITING'
  }
}

const toPercentMetric = (value, decimals = 1) => {
  const numeric = toFiniteNumber(value)
  if (numeric == null) return ''
  return `${numeric.toFixed(decimals)}%`
}

const extractTerminalSections = (raw = '', label = '') => {
  const cleaned = normalizeFinalReportText(raw)
  if (!cleaned) {
    return {
      sourceText: raw,
      cleanedText: '',
      executiveLines: [],
      actionItems: [],
      hasAction: false,
    }
  }

  const executiveSection = extractReportSection(
    cleaned,
    ['Executive Summary', 'Summary of Key Arguments', label],
    ['Action Plan']
  )
  const actionSection = extractReportSection(cleaned, ['Action Plan'], [])
  const blocks = cleaned
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  const executiveSource =
    executiveSection ||
    extractReportPrelude(cleaned, ['Action Plan']) ||
    blocks[0] ||
    cleaned
  const actionSource =
    actionSection ||
    (blocks.length > 1 ? blocks.slice(1).join('\n\n') : '')

  const executiveLines = toTerminalLines(executiveSource, { ignoredHeadings: [label] })
  const actionLines = toTerminalLines(actionSource, { ignoredHeadings: [label] })
  const actionItems = buildTerminalItemsFromLines(actionLines)
  const executiveFingerprint = executiveLines.join('\n').trim()
  const actionFingerprint = actionItems.map((item) => item.text).join('\n').trim()
  const hasAction =
    actionItems.length > 0 &&
    Boolean(actionFingerprint) &&
    actionFingerprint !== executiveFingerprint

  return {
    sourceText: raw,
    cleanedText: cleaned,
    executiveLines: executiveLines.length > 0 ? executiveLines : toTerminalLines(cleaned, { ignoredHeadings: [label] }),
    actionItems: hasAction ? actionItems : [],
    hasAction,
  }
}


export default function FinalReportsPanel({ tabLabel = '' }) {
  const { state } = useTradingFloor()
  const { pipelineState = {}, taRunStats = {}, agentStates = {}, liveTaReports = {} } = state
  const isBackendConnected = Boolean(state.connected)

  const [latestRunSummary, setLatestRunSummary] = useState(null)
  const [latestRunDetails, setLatestRunDetails] = useState(null)
  const [sessionCompletedRun, setSessionCompletedRun] = useState(null)
  const [liveDecisionPackage, setLiveDecisionPackage] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selectedReportKey, setSelectedReportKey] = useState(null)
  const [isPinnedSelection, setIsPinnedSelection] = useState(false)
  const [selectedArchiveReportKey, setSelectedArchiveReportKey] = useState('risk_judge')
  const [liveTerminal, setLiveTerminal] = useState(null)
  const [isRetryingRun, setIsRetryingRun] = useState(false)
  const [retryError, setRetryError] = useState('')
  const wasLiveRunRef = useRef(false)
  const liveRunIdentityRef = useRef(null)
  const archiveRunIdentityRef = useRef(null)
  const panelHeaderLabel = tabLabel ? `${String(tabLabel).toUpperCase()} · FINAL REPORTS` : 'FINAL REPORTS'
  const tabDrivenReportKey = TAB_TO_REPORT_KEY[String(tabLabel || '').trim().toLowerCase()] || null

  useEffect(() => {
    if (!tabDrivenReportKey) return
    setSelectedReportKey(tabDrivenReportKey)
    setSelectedArchiveReportKey(tabDrivenReportKey)
    setIsPinnedSelection(true)
  }, [tabDrivenReportKey])

  const fetchRunDetails = useCallback(async (runId, signal) => {
    if (!runId || !isBackendConnected) return null
    const response = await fetch(`${RUNS_API_BASE}/${runId}`, {
      cache: 'no-store',
      signal,
    })
    if (!response.ok) return null
    return readJsonSafely(response)
  }, [isBackendConnected])

  const loadLatestCompletedRun = useCallback(async (signal) => {
    if (!isBackendConnected) {
      if (!signal?.aborted) {
        setIsLoading(false)
        setLoadError('')
      }
      return null
    }
    setIsLoading(true)
    setLoadError('')

    try {
      const latestResponse = await fetch(`${RUNS_API_BASE}/latest`, {
        cache: 'no-store',
        signal,
      })

      let latestRun = null
      let listedRuns = []
      if (latestResponse.ok) {
        const latestPayload = await readJsonSafely(latestResponse)
        latestRun = latestPayload?.run || null
      }

      const listResponse = await fetch(`${RUNS_API_BASE}?limit=30`, {
        cache: 'no-store',
        signal,
      })
      if (listResponse.ok) {
        const listPayload = await readJsonSafely(listResponse)
        listedRuns = Array.isArray(listPayload?.runs) ? listPayload.runs : []
      }

      latestRun = selectLatestCompletedRun(
        [latestRun, ...listedRuns].filter(Boolean),
        { preferModern: true },
      )

      if (!latestRun?.run_id) {
        if (!signal?.aborted) {
          setLatestRunSummary(null)
          setLatestRunDetails(null)
        }
        return null
      }

      const fullRun = await fetchRunDetails(latestRun.run_id, signal)
      if (!signal?.aborted) {
        setLatestRunSummary(latestRun)
        setLatestRunDetails(fullRun || latestRun)
      }
      return fullRun || latestRun
    } catch (error) {
      if (error?.name === 'AbortError') return
      if (!isTransientTransportError(error)) {
        console.error('Failed to load latest TradingAgents run:', error)
      }
      if (!signal?.aborted) {
        setLoadError('ARCHIVE LINK LOST')
      }
      return null
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false)
      }
    }
  }, [fetchRunDetails, isBackendConnected])

  useEffect(() => {
    if (!isBackendConnected || !pipelineState?.active_run_id) return undefined
    const controller = new AbortController()
    loadLatestCompletedRun(controller.signal)
    return () => controller.abort()
  }, [isBackendConnected, loadLatestCompletedRun, pipelineState?.active_run_id])

  useEffect(() => {
    if (!isBackendConnected) return undefined
    let controller = null

    const handleDecisionUpdate = (event) => {
      const summary = event.detail
      const activeRunId = pipelineState?.active_run_id || null
      if (summary?.run_id && activeRunId && summary.run_id === activeRunId) {
        setLiveDecisionPackage(summary)
      }
      if (!summary?.run_id || !isCompletedTradingAgentsRun(summary)) return
      if (isLegacyTradingAgentsRun(summary)) return
      setSessionCompletedRun((prev) => {
        if (!prev?.run_id) return summary
        return getRunTimestampMs(summary) >= getRunTimestampMs(prev) ? summary : prev
      })

      if (controller) controller.abort()
      controller = new AbortController()
      loadLatestCompletedRun(controller.signal)
    }

    window.addEventListener(TRADE_DECISION_EVENT, handleDecisionUpdate)
    return () => {
      if (controller) controller.abort()
      window.removeEventListener(TRADE_DECISION_EVENT, handleDecisionUpdate)
    }
  }, [isBackendConnected, loadLatestCompletedRun, pipelineState?.active_run_id])

  useEffect(() => {
    if (!isBackendConnected) return undefined
    const terminalStatus = String(taRunStats?.status || '').toLowerCase()
    const isTerminalStats =
      taRunStats?.completed === true ||
      ['complete', 'completed', 'failed', 'aborted', 'degraded'].includes(terminalStatus)
    if (!isTerminalStats) return undefined
    if (sessionCompletedRun?.run_id) return undefined

    const controller = new AbortController()
    loadLatestCompletedRun(controller.signal)
    return () => controller.abort()
  }, [
    isBackendConnected,
    loadLatestCompletedRun,
    taRunStats?.status,
    taRunStats?.completed,
    sessionCompletedRun?.run_id,
  ])

  const displayRun = useMemo(() => {
    const hasFullSession = Boolean(
      sessionCompletedRun?.raw_state?.final_trade_decision ||
      sessionCompletedRun?.raw_state?.final_decision
    )
    if (hasFullSession) return sessionCompletedRun
    return sessionCompletedRun || null
  }, [sessionCompletedRun])
  const reportSections = useMemo(() => {
    return TRADING_AGENT_REPORT_CARD_DEFS.map((reportDef) => ({
      ...reportDef,
      agents: [reportDef.agentId],
      agentNames: [TRADING_AGENT_BY_ID[reportDef.agentId]?.name || reportDef.agentId],
    }))
  }, [])

  const livePhaseNum = Number(pipelineState.phase_num || 0)
  const livePhase = String(pipelineState.phase || 'IDLE').toUpperCase()
  const liveAgent = pipelineState.agent_display_name || pipelineState.current_step || 'Awaiting agent'
  const activeRunId = pipelineState?.active_run_id || null
  const tickerFromRunId = useCallback((runId) => {
    const raw = String(runId || '')
    const match = raw.match(/^ta-([A-Za-z0-9._-]+)-/)
    return String(match?.[1] || '').toUpperCase()
  }, [])
  const liveDecisionForRun =
    activeRunId && liveDecisionPackage?.run_id === activeRunId
      ? liveDecisionPackage
      : null
  const liveTicker = String(
    pipelineState.ticker ||
    pipelineState.current_ticker ||
    liveDecisionForRun?.ticker ||
    liveDecisionForRun?.symbol ||
    liveDecisionForRun?.raw_state?.ticker ||
    liveDecisionForRun?.raw_state?.current_ticker ||
    tickerFromRunId(activeRunId) ||
    tickerFromRunId(taRunStats?.runId) ||
    ''
  ).toUpperCase()
  const liveDepth = String(pipelineState.research_depth || 'quick').toUpperCase()
  const isTradingAgentsMode = String(pipelineState.pipeline_mode || '').toLowerCase() === 'tradingagents'
  const isCompletedLive = isTradingAgentsMode && livePhase === 'COMPLETE'
  const hasActiveLivePhase =
    livePhaseNum > 0 &&
    livePhase !== 'IDLE' &&
    livePhase !== 'READY' &&
    livePhase !== 'COMPLETE' &&
    livePhase !== 'FAILED' &&
    livePhase !== 'ABORTED'
  const isTerminalLive =
    isTradingAgentsMode &&
    (livePhase === 'FAILED' || livePhase === 'ABORTED')
  const hasSessionTerminalContext =
    Boolean(activeRunId) &&
    String(taRunStats?.runId || '') === String(activeRunId)
  const isLiveRun =
    (taRunStats?.running === true && !isCompletedLive && !isTerminalLive) ||
    (isTradingAgentsMode && hasActiveLivePhase)
  const hasLiveDecisionPackage = Boolean(liveDecisionForRun?.run_id || liveDecisionForRun?.ticker)
  const showLiveRun = isLiveRun && !isCompletedLive

  const resolveAgentStateEntry = (agentId, agentName) => {
    const candidates = [
      agentName,
      normalizeTradingAgentName(agentName),
      String(agentName || '').replace(/_/g, ' '),
      agentId,
      normalizeTradingAgentName(agentId),
      String(agentId || '').replace(/_/g, ' '),
    ].filter(Boolean)

    for (const key of candidates) {
      if (agentStates?.[key]) return agentStates[key]
    }
    return null
  }

  const activeAgentId = normalizeTradingAgentId(pipelineState.current_step || pipelineState.agent_display_name)
  const activeReportKey = activeAgentId || null
  const activeReportIndex = useMemo(
    () => reportSections.findIndex((section) => section.key === activeReportKey),
    [reportSections, activeReportKey]
  )
  const riskJudgeName = normalizeTradingAgentName('risk_judge') || 'Risk Judge'
  const riskJudgeState = resolveAgentStateEntry('risk_judge', riskJudgeName) || {}
  const liveRawStateReportMap = useMemo(
    () =>
      reportSections.reduce((map, reportDef) => {
        map[reportDef.key] = resolveAgentRawStateReportText(liveDecisionForRun?.raw_state || {}, reportDef.agentId)
        return map
      }, {}),
    [liveDecisionForRun, reportSections]
  )
  const liveFinalRaw = extractReportText(
    liveDecisionForRun?.raw_state?.final_trade_decision ||
    liveDecisionForRun?.raw_state?.final_decision ||
    liveRawStateReportMap.risk_judge ||
    riskJudgeState?.report ||
    riskJudgeState?.reasoning ||
    riskJudgeState?.decision
  )
  const cleanedFinalRaw = normalizeFinalReportText(liveFinalRaw)
  const liveFinalSummary = compactRunText(cleanedFinalRaw, 240)
  const hasLiveFinalSummary = liveFinalSummary && liveFinalSummary !== '--'
  const liveActionLabel = standardizeAction(
    liveDecisionForRun?.recommended_action ||
    liveDecisionForRun?.model_action ||
    riskJudgeState?.decision
  )
  const sanitizeLiveActionLabel = (value = '') => {
    const raw = String(value || '').trim()
    if (!raw) return ''
    if (/^TRADINGAGENTS_ANALYSIS_COMPLETE/i.test(raw)) return ''
    return raw
  }
  const cleanedLiveActionLabel = sanitizeLiveActionLabel(liveActionLabel)
  const resolveActionKeyword = (value = '') => {
    const normalized = standardizeAction(value)
    return ['BUY', 'SELL', 'HOLD'].includes(normalized) ? normalized : ''
  }
  const liveActionKeyword = resolveActionKeyword(cleanedLiveActionLabel)

  const liveAgentReportMap = useMemo(() => {
    const reports = Array.isArray(liveDecisionForRun?.agent_reports) ? liveDecisionForRun.agent_reports : []
    const map = new Map()
    reports.forEach((report) => {
      const normalized = normalizeTradingAgentName(report?.agent) || report?.agent
      if (normalized) map.set(normalized, report)
    })
    return map
  }, [liveDecisionForRun])

  const liveCompleteReportText = useMemo(
    () =>
      normalizeFinalReportText(
        liveDecisionForRun?.complete_report ||
        liveDecisionForRun?.raw_state?.complete_report ||
        ''
      ),
    [liveDecisionForRun]
  )

  const isLivePackageCompleted = useMemo(() => {
    return Boolean(
      String(liveDecisionForRun?.run_status || liveDecisionForRun?.status || '').toUpperCase() === 'COMPLETED' ||
      liveDecisionForRun?.raw_state?.final_trade_decision ||
      liveDecisionForRun?.raw_state?.final_decision ||
      String(pipelineState?.phase || '').toUpperCase() === 'COMPLETE'
    )
  }, [liveDecisionForRun, pipelineState?.phase])

  const resolveLiveAgentReport = useCallback((agentId, agentName) => {
    const candidates = [
      agentName,
      normalizeTradingAgentName(agentName),
      TRADING_AGENT_BY_ID[agentId]?.name,
      normalizeTradingAgentName(agentId),
      String(agentName || '').replace(/_/g, ' '),
      String(agentName || '').replace(/\s+/g, '_').toLowerCase(),
    ].filter(Boolean)

    for (const candidate of candidates) {
      const normalized = normalizeTradingAgentName(candidate) || candidate
      if (liveAgentReportMap.has(normalized)) return liveAgentReportMap.get(normalized)
    }
    return null
  }, [liveAgentReportMap])

  const liveReportSourceMap = useMemo(() => {
    return reportSections.reduce((map, section) => {
      const agentId = section.agents?.[0]
      const agentName =
        section.agentNames?.[0] ||
        TRADING_AGENT_BY_ID[agentId]?.name ||
        normalizeTradingAgentName(agentId) ||
        agentId
      const cachedReport = liveTaReports?.[section.key]
      const agentReport = resolveLiveAgentReport(agentId, agentName)
      const storedReport = resolveAgentStoredFullReportText(agentReport)
      const rawReport = liveRawStateReportMap[section.key]

      const baseFull = section.key === 'risk_judge'
        ? (
          liveCompleteReportText ||
          cachedReport?.report ||
          cachedReport?.rawText ||
          storedReport ||
          liveDecisionForRun?.raw_state?.final_trade_decision ||
          liveDecisionForRun?.raw_state?.final_decision ||
          rawReport
        )
        : (
          cachedReport?.report ||
          cachedReport?.rawText ||
          storedReport ||
          rawReport
        )

      const fullText = extractReportText(baseFull)
      const resolved = fullText || ''

      map[section.key] = {
        text: resolved,
        isFallback: false,
      }
      return map
    }, {})
  }, [
    reportSections,
    liveTaReports,
    liveDecisionForRun,
    liveRawStateReportMap,
    liveCompleteReportText,
    isLivePackageCompleted,
    resolveLiveAgentReport,
  ])

  const liveReportCards = useMemo(() => {
    const telemetryCompletedCount = Number(taRunStats?.reportSectionsCompleted || 0)
    const allCompleteByTelemetry = telemetryCompletedCount >= reportSections.length
    const taStatus = String(taRunStats?.status || '').toLowerCase()
    const isRetrying = taStatus === 'retrying'
    const qualityFailedAgents = new Set(
      (Array.isArray(taRunStats?.invalidAgents) ? taRunStats.invalidAgents : [])
        .map((item) => normalizeTradingAgentId(item?.agent || item?.agent_display_name))
        .filter(Boolean)
    )
    const fallbackActiveIndex =
      !activeReportKey && taRunStats?.running
        ? Math.min(Math.max(telemetryCompletedCount, 0), reportSections.length - 1)
        : -1

    return reportSections.map((section, index) => {
      const agentId = section.agents?.[0]
      const agentName =
        section.agentNames?.[0] ||
        TRADING_AGENT_BY_ID[agentId]?.name ||
        normalizeTradingAgentName(agentId) ||
        agentId

      const sourceEntry = liveReportSourceMap[section.key]
      const rawText =
        typeof sourceEntry === 'string'
          ? sourceEntry
          : (sourceEntry?.text || '')
      const hasContent = isDisplayReadyReport(rawText)
      const hasTelemetryCompletion = Boolean(
        taRunStats?.reportSections?.[section.key] ||
        taRunStats?.completedAgents?.[section.key] ||
        taRunStats?.completedAgents?.[agentId]
      )
      const hasQualityFailure = Boolean(qualityFailedAgents.has(agentId))
      const isActive = activeReportKey === section.key
      const isFallbackActive = index === fallbackActiveIndex
      const hasPassed = activeReportIndex > -1 && index < activeReportIndex
      const isComplete = Boolean(allCompleteByTelemetry || hasContent || hasTelemetryCompletion)

      let status = 'pending'
      if (isLivePackageCompleted || allCompleteByTelemetry) {
        status = isComplete ? 'complete' : 'missing'
      } else if (hasQualityFailure) {
        status = isRetrying ? 'retrying' : 'quality_failed'
      } else if (hasTelemetryCompletion || (hasPassed && isComplete)) {
        status = 'complete'
      } else if (isActive || isFallbackActive) {
        status = 'active'
      }

      let summary = 'AWAITING ANALYSIS...'
      if (status === 'complete') summary = 'REPORT RECEIVED.'
      else if (status === 'active') summary = 'ANALYZING...'
      else if (status === 'missing') summary = 'MISSING REPORT.'
      else if (status === 'retrying') summary = 'RETRYING QUALITY CHECK...'
      else if (status === 'quality_failed') summary = 'QUALITY CHECK FAILED.'

      return {
        ...section,
        status,
        index: String(index + 1).padStart(2, '0'),
        summary,
        isSelectable: hasContent && Boolean(rawText),
        agentName,
        rawText,
      }
    })
  }, [
    reportSections,
    liveReportSourceMap,
    activeReportKey,
    activeReportIndex,
    isLivePackageCompleted,
    taRunStats,
  ])

  const latestCompletedLiveReport = useMemo(() => {
    const completed = liveReportCards.filter((card) => card.status === 'complete')
    return completed.length > 0 ? completed[completed.length - 1] : null
  }, [liveReportCards])

  const archiveAgentReportMap = useMemo(() => {
    const reports = Array.isArray(displayRun?.agent_reports) ? displayRun.agent_reports : []
    const map = new Map()
    reports.forEach((report) => {
      const normalized = normalizeTradingAgentName(report?.agent) || report?.agent
      if (normalized) map.set(normalized, report)
    })
    return map
  }, [displayRun])

  const resolveArchiveAgentReport = useCallback((agentId, agentName) => {
    const candidates = [
      agentName,
      normalizeTradingAgentName(agentName),
      TRADING_AGENT_BY_ID[agentId]?.name,
      normalizeTradingAgentName(agentId),
      String(agentName || '').replace(/_/g, ' '),
      String(agentName || '').replace(/\s+/g, '_').toLowerCase(),
    ].filter(Boolean)

    for (const candidate of candidates) {
      const normalized = normalizeTradingAgentName(candidate) || candidate
      if (archiveAgentReportMap.has(normalized)) return archiveAgentReportMap.get(normalized)
    }
    return null
  }, [archiveAgentReportMap])

  const hasArchiveRunData = Boolean(
    displayRun?.run_id ||
    displayRun?.ticker ||
    displayRun?.symbol ||
    displayRun?.created_at
  )

  const archiveReportSourceMap = useMemo(() => {
    return reportSections.reduce((map, section) => {
      const agentId = section.agents?.[0]
      const agentName =
        section.agentNames?.[0] ||
        TRADING_AGENT_BY_ID[agentId]?.name ||
        normalizeTradingAgentName(agentId) ||
        agentId
      const agentReport = resolveArchiveAgentReport(agentId, agentName)
      const storedReport = resolveAgentStoredFullReportText(agentReport)
      const rawText =
        (section.key === 'risk_judge'
          ? extractReportText(displayRun?.complete_report || displayRun?.raw_state?.complete_report)
          : '') ||
        resolveAgentRawStateReportText(displayRun?.raw_state || {}, agentId) ||
        (section.key === 'risk_judge'
          ? extractReportText(
            displayRun?.raw_state?.final_trade_decision ||
            displayRun?.raw_state?.final_decision
          )
          : '')
      const fullText = extractReportText(rawText) || extractReportText(storedReport)
      const resolved = fullText || ''
      if (resolved) {
        map[section.key] = {
          text: resolved,
          isFallback: false,
        }
      }
      return map
    }, {})
  }, [displayRun, reportSections, resolveArchiveAgentReport])

  const archiveReportCards = useMemo(() => {
    return reportSections.map((section, index) => {
      const agentId = section.agents?.[0]
      const agentName =
        section.agentNames?.[0] ||
        TRADING_AGENT_BY_ID[agentId]?.name ||
        normalizeTradingAgentName(agentId) ||
        agentId

      const sourceEntry = archiveReportSourceMap[section.key]
      const rawText =
        typeof sourceEntry === 'string'
          ? sourceEntry
          : (sourceEntry?.text || '')
      const cleanedText = normalizeFinalReportText(rawText)
      const hasContent = isArchiveReadyReport(rawText)
      const isComplete = hasArchiveRunData && hasContent
      const summaryText = !hasArchiveRunData
        ? 'AWAITING RUN...'
        : hasContent
        ? compactRunText(cleanedText || rawText, 120)
        : 'MISSING REPORT.'

      return {
        ...section,
        index: String(index + 1).padStart(2, '0'),
        summary: summaryText || 'REPORT RECEIVED.',
        rawText,
        isSelectable: hasArchiveRunData && hasContent,
        status: hasArchiveRunData ? (isComplete ? 'complete' : 'missing') : 'pending',
      }
    })
  }, [reportSections, archiveReportSourceMap, hasArchiveRunData])

  const liveRunIdentity =
    activeRunId ||
    `${liveTicker}:${liveDepth}:${pipelineState?.timestamp || livePhaseNum || 'live'}`

  useEffect(() => {
    if (!showLiveRun) {
      setSelectedReportKey(null)
      setIsPinnedSelection(false)
      liveRunIdentityRef.current = null
      if (liveDecisionPackage) setLiveDecisionPackage(null)
      return
    }

    if (liveRunIdentityRef.current !== liveRunIdentity) {
      liveRunIdentityRef.current = liveRunIdentity
      setSessionCompletedRun(null)
      setSelectedReportKey(null)
      setIsPinnedSelection(false)
      if (liveDecisionPackage && liveDecisionPackage?.run_id !== activeRunId) {
        setLiveDecisionPackage(null)
      }
    }
  }, [showLiveRun, liveRunIdentity, liveDecisionPackage, activeRunId])

  useEffect(() => {
    if (!showLiveRun) return

    const selectedCard = liveReportCards.find(
      (card) => card.key === selectedReportKey && card.status === 'complete'
    )

    if (isPinnedSelection && selectedCard) return

    setSelectedReportKey(latestCompletedLiveReport?.key || null)
    if (!selectedCard) {
      setIsPinnedSelection(false)
    }
  }, [showLiveRun, liveReportCards, latestCompletedLiveReport, selectedReportKey, isPinnedSelection])

  useEffect(() => {
    if (!showLiveRun || isPinnedSelection) return
    const sourceReportSlot = Number(state.activeScene?.sourceReportSlot || 0)
    if (!Number.isFinite(sourceReportSlot) || sourceReportSlot <= 0) return
    const reportDef = TRADING_AGENT_REPORT_CARD_BY_SLOT[sourceReportSlot]
    if (!reportDef?.key) return
    setSelectedReportKey(reportDef.key)
  }, [showLiveRun, isPinnedSelection, state.activeScene?.sourceReportSlot])

  useEffect(() => {
    const archiveIdentity =
      displayRun?.run_id ||
      displayRun?.created_at ||
      latestRunSummary?.run_id ||
      'archive'
    const defaultArchiveKey =
      archiveReportCards.find((card) => card.key === 'risk_judge' && card.isSelectable)?.key ||
      [...archiveReportCards].reverse().find((card) => card.isSelectable)?.key ||
      archiveReportCards[0]?.key ||
      'risk_judge'

    if (archiveRunIdentityRef.current !== archiveIdentity) {
      archiveRunIdentityRef.current = archiveIdentity
      setSelectedArchiveReportKey(defaultArchiveKey)
      return
    }

    if (!archiveReportCards.some((card) => card.key === selectedArchiveReportKey)) {
      setSelectedArchiveReportKey(defaultArchiveKey)
    }
  }, [displayRun?.run_id, displayRun?.created_at, latestRunSummary?.run_id, archiveReportCards, selectedArchiveReportKey])

  const selectedLiveReport = useMemo(
    () =>
      liveReportCards.find((card) => card.key === selectedReportKey) ||
      latestCompletedLiveReport ||
      null,
    [liveReportCards, selectedReportKey, latestCompletedLiveReport]
  )

  const selectedArchiveReport = useMemo(
    () =>
      archiveReportCards.find((card) => card.key === selectedArchiveReportKey) ||
      archiveReportCards.find((card) => card.key === 'risk_judge' && card.isSelectable) ||
      archiveReportCards.find((card) => card.isSelectable) ||
      null,
    [archiveReportCards, selectedArchiveReportKey]
  )

  const liveTerminalSections = useMemo(() => {
    const selectedRaw =
      selectedLiveReport?.key === 'risk_judge' && liveCompleteReportText
        ? liveCompleteReportText
        : (selectedLiveReport?.rawText || '')
    return extractTerminalSections(selectedRaw, selectedLiveReport?.label || '')
  }, [selectedLiveReport, liveCompleteReportText])

  const archiveTerminalSections = useMemo(() => {
    const archiveComplete = normalizeFinalReportText(
      displayRun?.complete_report || displayRun?.raw_state?.complete_report || ''
    )
    const selectedRaw =
      selectedArchiveReport?.key === 'risk_judge' && archiveComplete
        ? archiveComplete
        : (selectedArchiveReport?.rawText || '')
    return extractTerminalSections(selectedRaw, selectedArchiveReport?.label || '')
  }, [selectedArchiveReport, displayRun])

  const liveSwarmStatuses = useMemo(() => {
    if (!showLiveRun) return agentStates

    const nextStatuses = { ...(agentStates || {}) }
    const markCompleted = (key) => {
      if (!key) return
      const existing = nextStatuses[key]
      nextStatuses[key] =
        existing && typeof existing === 'object'
          ? { ...existing, status: 'completed' }
          : { status: 'completed' }
    }

    liveReportCards
      .filter((card) => card.status === 'complete')
      .forEach((card) => {
        ;(card.agents || []).forEach((agentId) => {
          const agentName = normalizeTradingAgentName(agentId) || TRADING_AGENT_BY_ID[agentId]?.name || agentId
          markCompleted(agentId)
          markCompleted(agentName)
          markCompleted(String(agentName || '').replace(/_/g, ' '))
          markCompleted(String(agentName || '').replace(/\s+/g, '_').toLowerCase())
        })
      })

    const liveAgentReports = Array.isArray(liveDecisionForRun?.agent_reports)
      ? liveDecisionForRun.agent_reports
      : []
    liveAgentReports.forEach((report) => {
      const agentName = normalizeTradingAgentName(report?.agent) || report?.agent
      const agentId = normalizeTradingAgentId(report?.agent) || normalizeTradingAgentId(agentName)
      markCompleted(agentId)
      markCompleted(agentName)
      markCompleted(String(agentName || '').replace(/_/g, ' '))
      markCompleted(String(agentName || '').replace(/\s+/g, '_').toLowerCase())
    })

    return nextStatuses
  }, [showLiveRun, agentStates, liveReportCards, liveDecisionForRun])

  const archiveSwarmStatuses = useMemo(() => {
    const reports = Array.isArray(displayRun?.agent_reports) ? displayRun.agent_reports : []
    if (reports.length === 0) return agentStates

    const nextStatuses = { ...(agentStates || {}) }
    const markCompleted = (key) => {
      if (!key) return
      const existing = nextStatuses[key]
      nextStatuses[key] =
        existing && typeof existing === 'object'
          ? { ...existing, status: 'completed' }
          : { status: 'completed' }
    }

    reports.forEach((report) => {
      const agentName = normalizeTradingAgentName(report?.agent) || report?.agent
      const agentId = normalizeTradingAgentId(report?.agent || agentName)
      markCompleted(agentId)
      markCompleted(agentName)
      markCompleted(String(agentName || '').replace(/_/g, ' '))
      markCompleted(String(agentName || '').replace(/\s+/g, '_').toLowerCase())
    })

    return nextStatuses
  }, [displayRun, agentStates])

  const idleDisplayRun = displayRun || null
  const hasSelectableArchiveReport = archiveReportCards.some((card) => card.isSelectable)
  const hasSelectableLiveReport = liveReportCards.some((card) => card.isSelectable)
  const hasTerminalStatsWithoutArchive =
    (taRunStats?.completed === true || ['complete', 'completed'].includes(String(taRunStats?.status || '').toLowerCase())) &&
    !hasSelectableArchiveReport
  const hasPendingCurrentRun =
    Boolean(activeRunId) &&
    isTradingAgentsMode &&
    !isCompletedLive
  const showArchiveDashboard =
    !showLiveRun &&
    !liveTerminal &&
    hasSelectableArchiveReport &&
    !hasPendingCurrentRun
  const showCompletedLiveFallback =
    !showLiveRun &&
    !liveTerminal &&
    !showArchiveDashboard &&
    !hasPendingCurrentRun &&
    hasTerminalStatsWithoutArchive &&
    hasSelectableLiveReport
  const showIdleDashboard =
    !showLiveRun &&
    !liveTerminal &&
    !showArchiveDashboard &&
    !showCompletedLiveFallback &&
    !hasLiveDecisionPackage &&
    !isCompletedLive &&
    !hasPendingCurrentRun

  useEffect(() => {
    if (isLiveRun) {
      setLiveTerminal(null)
      return
    }
    if (isTerminalLive && hasSessionTerminalContext) {
      setLiveTerminal({
        status: livePhase,
        ticker: liveTicker,
        agent: liveAgent,
        errorCode: pipelineState?.error_code || null,
        errorMessage: pipelineState?.error_message || pipelineState?.message || null,
        failedStage: pipelineState?.failed_stage || null,
        failedAgent: pipelineState?.failed_agent || null,
        attempt: pipelineState?.attempt || null,
        maxAttempts: pipelineState?.max_attempts || null,
        timestamp: pipelineState?.timestamp || new Date().toISOString(),
      })
      return
    }
    setLiveTerminal(null)
  }, [
    isLiveRun,
    isTerminalLive,
    livePhase,
    liveTicker,
    liveAgent,
    pipelineState?.timestamp,
    pipelineState?.error_code,
    pipelineState?.error_message,
    pipelineState?.message,
    pipelineState?.failed_stage,
    pipelineState?.failed_agent,
    pipelineState?.attempt,
    pipelineState?.max_attempts,
    taRunStats?.runId,
    hasSessionTerminalContext,
  ])

  useEffect(() => {
    if (!showLiveRun) return
    if (activeRunId && liveDecisionPackage && liveDecisionPackage?.run_id !== activeRunId) {
      setLiveDecisionPackage(null)
    }
  }, [showLiveRun, activeRunId, liveDecisionPackage])

  useEffect(() => {
    if (!isBackendConnected) return undefined
    let controller = null

    if (wasLiveRunRef.current && !isLiveRun && isCompletedLive) {
      controller = new AbortController()
      setLiveTerminal(null)
      loadLatestCompletedRun(controller.signal).then((run) => {
        if (run && !controller.signal.aborted) {
          setSessionCompletedRun(run)
        }
      })
    }

    wasLiveRunRef.current = isLiveRun

    return () => {
      if (controller) controller.abort()
    }
  }, [isBackendConnected, isCompletedLive, isLiveRun, loadLatestCompletedRun])

  const handleRetryRun = useCallback(async () => {
    const ticker = String(pipelineState?.ticker || pipelineState?.current_ticker || liveTicker || '').trim().toUpperCase()
    if (!ticker || isRetryingRun) return
    setRetryError('')
    setIsRetryingRun(true)
    try {
      const response = await fetch('/api/admin/trading-agents/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker,
          date: pipelineState?.trade_date || new Date().toISOString().slice(0, 10),
          provider: pipelineState?.llm_provider || 'nvidia',
          quickModel: pipelineState?.quick_model || '',
          deepModel: pipelineState?.deep_model || '',
          outputLanguage: pipelineState?.output_language || 'English',
          depth: pipelineState?.research_depth || 'quick',
          dramaLevel: pipelineState?.drama_level || 'Medium',
          sceneDialoguePreset: pipelineState?.scene_dialogue_preset || null,
        }),
      })
      const payload = await readJsonSafely(response)
      if (!response.ok || !payload?.success) {
        setRetryError(payload?.error || payload?.message || 'Retry failed to start.')
      }
    } catch (error) {
      setRetryError(String(error?.message || error || 'Retry failed to start.'))
    } finally {
      setIsRetryingRun(false)
    }
  }, [pipelineState, liveTicker, isRetryingRun])

  const _actionLabel = getRunActionLabel(displayRun)
  const liveStep = TRADING_AGENT_WORKFLOW_STEP_BY_NUMBER[livePhaseNum]
  const livePhaseLabel = liveStep?.label || compactRunText(livePhase, 80)
  const sanitizeTerminalLine = (text = '') => text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[•✅❌]/g, '')
    .replace(/^\s*>\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const hasIdleArchiveData = hasArchiveRunData
  const recommendation = (() => {
    if (hasIdleArchiveData) {
      const normalized = standardizeAction(
        displayRun?.recommended_action ||
        displayRun?.model_action ||
        displayRun?.action ||
        ''
      )
      if (normalized && normalized !== 'IDLE') return normalized
    }
    const inferred = inferActionFromText(
      cleanedFinalRaw ||
      liveCompleteReportText ||
      latestCompletedLiveReport?.rawText ||
      selectedLiveReport?.rawText ||
      ''
    )
    return inferred || 'IDLE'
  })()
  const ticker = (displayRun?.ticker || displayRun?.symbol || pipelineState?.ticker || '----').toUpperCase()
  const tacticalDisplayRun = idleDisplayRun || displayRun || null
  const tacticalTicker = (tacticalDisplayRun?.ticker || tacticalDisplayRun?.symbol || ticker || '----').toUpperCase()
  const tacticalMarketCap = (
    toDisplayMetric(tacticalDisplayRun?.metadata?.market_cap_formatted) ||
    toPercentMetric(tacticalDisplayRun?.performance?.alpha_pct, 1) ||
    toPercentMetric(tacticalDisplayRun?.performance?.portfolio_return_pct, 1) ||
    '2.17B'
  )
  const tacticalVolatility = (
    toDisplayMetric(tacticalDisplayRun?.metadata?.volatility) ||
    toPercentMetric(tacticalDisplayRun?.portfolio_risk?.max_position_weight_pct, 1) ||
    toPercentMetric(
      toFiniteNumber(tacticalDisplayRun?.portfolio_risk?.concentration_score) != null
        ? Number(tacticalDisplayRun?.portfolio_risk?.concentration_score) * 100
        : null,
      2
    ) ||
    toPercentMetric(
      toFiniteNumber(tacticalDisplayRun?.confidence) != null
        ? Number(tacticalDisplayRun?.confidence) * 100
        : null,
      1
    ) ||
    '8.0%'
  )
  const formatMetaTimestamp = (value = '') => {
    if (!value) return ''
    const normalized = (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/i.test(value.trim()) &&
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())
    )
      ? `${value.trim()}Z`
      : value
    const parsed = new Date(normalized)
    if (Number.isNaN(parsed.getTime())) return String(value)
    return parsed.toLocaleString()
  }
  const normalizeTimestampValue = (value = '') => {
    if (!value) return ''
    const raw = String(value).trim()
    if (!raw) return ''
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/i.test(raw) &&
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)
    )
      ? `${raw}Z`
      : raw
  }
  const formatReportDate = (value = '') => {
    if (!value) return '--'
    const raw = String(value).trim()
    const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (isoDate) return `${isoDate[3]}/${isoDate[2]}/${isoDate[1]}`
    const parsed = new Date(normalizeTimestampValue(raw))
    if (Number.isNaN(parsed.getTime())) return raw || '--'
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(parsed)
  }
  const formatReportTime = (value = '') => {
    if (!value) return '--'
    const parsed = new Date(normalizeTimestampValue(value))
    if (Number.isNaN(parsed.getTime())) return String(value).trim() || '--'
    return parsed.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  const formatDepthLabel = (value = '') => {
    const raw = String(value || '').trim()
    if (!raw) return '--'
    const lower = raw.toLowerCase()
    if (lower === '1') return 'QUICK'
    if (lower === '3') return 'STANDARD'
    if (lower === '5') return 'DEEP'
    if (['quick', 'standard', 'deep'].includes(lower)) return lower.toUpperCase()
    return raw.toUpperCase()
  }
  const formatModelName = (value = '') => {
    const raw = String(value || '').trim()
    if (!raw) return ''
    const model = raw
      .split('/')
      .pop()
      .replace(/:(?:free|latest)$/i, '')
      .replace(/-\d{4}$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\binstruct\b/gi, '')
      .replace(/\ba3b\b/gi, 'A3B')
      .replace(/\ba12b\b/gi, 'A12B')
      .replace(/\b(\d+)b\b/gi, '$1B')
      .replace(/\b(\d+)m\b/gi, '$1M')
      .replace(/\bgpt oss\b/gi, 'GPT-OSS')
      .replace(/\bqwen3\b/gi, 'Qwen3')
      .replace(/\bnext\b/gi, 'Next')
      .replace(/\bstockmark\b/gi, 'Stockmark')
      .replace(/\bnemotron\b/gi, 'Nemotron')
      .replace(/\bmistral\b/gi, 'Mistral')
      .replace(/\blarge\b/gi, 'Large')
      .replace(/\s+/g, ' ')
      .trim()
    return model || raw
  }
  const formatModelsMeta = (quickModel = '', deepModel = '') => {
    const quick = formatModelName(quickModel)
    const deep = formatModelName(deepModel || quickModel)
    const quickValue = quick || '--'
    const deepValue = deep || '--'
    return {
      quick: quickValue,
      deep: deepValue,
      title: `Quick: ${quickValue}\nDeep: ${deepValue}`,
    }
  }
  const archiveAttempt = Number(tacticalDisplayRun?.attempt || tacticalDisplayRun?.raw_state?.attempt || 0)
  const archiveMaxAttempts = Number(tacticalDisplayRun?.max_attempts || tacticalDisplayRun?.raw_state?.max_attempts || 0)
  const archiveAttemptLabel = archiveAttempt > 0
    ? `${archiveAttempt}${archiveMaxAttempts > 0 ? `/${archiveMaxAttempts}` : ''}`
    : ''
  const archiveTimestamp = formatMetaTimestamp(
    tacticalDisplayRun?.upstream_generated_at ||
    tacticalDisplayRun?.raw_state?.upstream_generated_at ||
    tacticalDisplayRun?.completed_at ||
    tacticalDisplayRun?.created_at
  )
  const archiveReportDate = formatReportDate(
    tacticalDisplayRun?.trade_date ||
    tacticalDisplayRun?.raw_state?.trade_date
  )
  const archiveReportTime = formatReportTime(
    tacticalDisplayRun?.upstream_generated_at ||
    tacticalDisplayRun?.raw_state?.upstream_generated_at ||
    tacticalDisplayRun?.completed_at ||
    tacticalDisplayRun?.created_at
  )
  const archiveDepthLabel = formatDepthLabel(
    tacticalDisplayRun?.research_depth ||
    tacticalDisplayRun?.raw_state?.research_depth
  )
  const archiveModelsMeta = formatModelsMeta(
    tacticalDisplayRun?.quick_model || tacticalDisplayRun?.raw_state?.quick_model,
    tacticalDisplayRun?.deep_model || tacticalDisplayRun?.raw_state?.deep_model
  )
  const resolveLoadingLabel = () => {
    const activeSection = reportSections.find((section) => section.key === activeReportKey)
    const base = activeSection?.label || livePhaseLabel || normalizeTradingAgentName(activeAgentId) || liveAgent || 'ANALYZING'
    return String(base || '')
      .replace(/TRADINGAGENTS[_\s-]*ANALYSIS[_\s-]*COMPLETE[_A-Z0-9_]*\b/gi, '')
      .replace(/[_\s-]*ANALYSIS[_\s-]*COMPLETE[_A-Z0-9_]*\b/gi, '')
      .replace(/[_\s-]*TOOL[_\s-]*PASS\b/gi, '')
      .replace(/[_\s-]+/g, ' ')
      .trim()
  }
  const liveLoadingLabel = resolveLoadingLabel()
  const hasFinalDecisionSignal = Boolean(
    activeReportKey === 'risk_judge' ||
    liveDecisionForRun?.raw_state?.final_trade_decision ||
    liveDecisionForRun?.raw_state?.final_decision ||
    latestCompletedLiveReport?.key === 'risk_judge'
  )
  const liveHeroAction = hasFinalDecisionSignal
    ? liveActionKeyword
    : (liveLoadingLabel ? liveLoadingLabel.toUpperCase() : 'ANALYZING')
  const liveHeroTicker = String(
    liveTicker ||
    pipelineState?.ticker ||
    pipelineState?.current_ticker ||
    displayRun?.ticker ||
    displayRun?.symbol ||
    displayRun?.raw_state?.ticker ||
    displayRun?.raw_state?.current_ticker ||
    latestRunSummary?.ticker ||
    tickerFromRunId(displayRun?.run_id) ||
    tickerFromRunId(latestRunSummary?.run_id) ||
    '----'
  ).toUpperCase()
  const liveReportDate = formatReportDate(
    pipelineState?.trade_date ||
    liveDecisionForRun?.trade_date ||
    liveDecisionForRun?.raw_state?.trade_date
  )
  const liveReportTime = formatReportTime(
    taRunStats?.upstreamGeneratedAt ||
    liveDecisionForRun?.upstream_generated_at ||
    liveDecisionForRun?.raw_state?.upstream_generated_at ||
    pipelineState?.timestamp
  )
  const liveDepthLabel = formatDepthLabel(
    pipelineState?.research_depth ||
    liveDecisionForRun?.research_depth ||
    liveDecisionForRun?.raw_state?.research_depth ||
    liveDepth
  )
  const liveModelsMeta = formatModelsMeta(
    pipelineState?.quick_model ||
    liveDecisionForRun?.quick_model ||
    liveDecisionForRun?.raw_state?.quick_model,
    pipelineState?.deep_model ||
    liveDecisionForRun?.deep_model ||
    liveDecisionForRun?.raw_state?.deep_model
  )
  const liveActiveCard = liveReportCards.find((card) => card.status === 'active') || null
  const liveCurrentLabel = liveActiveCard?.label || selectedLiveReport?.label || liveLoadingLabel || 'Report'
  const liveReaderStatus = selectedLiveReport
    ? `${selectedLiveReport.index}/12 ${formatSummaryStatus(selectedLiveReport.status)}`
    : liveActiveCard
    ? `${liveActiveCard.index}/12 ANALYZING`
    : 'AWAITING REPORT'

  const handleSelectLiveReport = (reportKey) => {
    setSelectedReportKey(reportKey)
    setIsPinnedSelection(true)
  }

  const handleSelectArchiveReport = (reportKey) => {
    setSelectedArchiveReportKey(reportKey)
  }

  const renderSummaryCard = (summary, { selected = false, onSelect = null } = {}) => {
    const isInteractive = typeof onSelect === 'function' && summary.isSelectable
    const className = [
      'tactical-summary-card',
      `is-${summary.status || 'pending'}`,
      isInteractive ? 'is-clickable' : '',
      selected ? 'is-selected' : '',
    ]
      .filter(Boolean)
      .join(' ')

    const content = (
      <>
        <div className="card-header-row">
          <div className="tucked-icon-box">
            <TacticalSummaryIcon sectionKey={summary.key} isFinal={summary.key === 'risk_judge'} />
          </div>
          <div className="card-label-stack">
            <span className="card-index">{summary.index}</span>
            <span className="card-label">{summary.label.replace(/\s+REPORT$/i, '')} REPORT</span>
            <span className="card-status-chip">{formatSummaryStatus(summary.status)}</span>
          </div>
        </div>
        <div className="card-body-row">
          <div className="tactical-summary-card__text">
            {summary.summary}
          </div>
        </div>
      </>
    )

    if (!isInteractive) {
      return (
        <div key={summary.key} className={className}>
          {content}
        </div>
      )
    }

    return (
      <button
        key={summary.key}
        type="button"
        className={`${className} tactical-summary-card--button`}
        onClick={() => onSelect(summary.key)}
        aria-pressed={selected}
        title={`View full ${summary.label}`}
      >
        {content}
      </button>
    )
  }

  const renderTerminalWindow = (reportCard, terminalSections, options = {}) => {
    const { windowClassName = '', bodyClassName = '' } = options
    if (!reportCard) return null

    const rawFullReportSource =
      terminalSections?.sourceText ||
      reportCard?.rawText ||
      terminalSections?.cleanedText ||
      ''
    const fullReportText = stripCliBanner(
      stripMetaTokensMultiline(extractReportText(rawFullReportSource) || rawFullReportSource)
    )
    const hasFullReport = Boolean(fullReportText)

    const executiveLines = terminalSections?.executiveLines?.length > 0
      ? terminalSections.executiveLines
      : ['REPORT RECEIVED.']
    const actionItems = terminalSections?.actionItems || []
    const hasAction = Boolean(terminalSections?.hasAction && actionItems.length > 0)

    return (
      <div
        key={reportCard.key}
        className={`tactical-terminal-window tactical-terminal--combined ${windowClassName}`.trim()}
      >
        <header className="tactical-terminal__header tactical-terminal__header--swarm">
          <span className="tactical-terminal__header-dot" />
          EXECUTIVE BRIEF / ACTION PLAN
        </header>
        <div className={`tactical-terminal__body ${bodyClassName}`.trim()}>
          {hasFullReport ? (
            <div className="terminal-section">
              <div className="terminal-section-kicker">{reportCard.label}</div>
              <div className="terminal-section-title">FULL REPORT</div>
              <pre className="terminal-pre">{fullReportText}</pre>
            </div>
          ) : null}

          {!hasFullReport ? (
            <>
              <div className="terminal-section">
                <div className="terminal-section-kicker">{reportCard.label}</div>
                <div className="terminal-section-title">EXECUTIVE BRIEF</div>
                <div className="terminal-block">
                  {executiveLines.map((line, index) => (
                    <div key={`${reportCard.key}-brief-${index}-${line}`} className="terminal-line">
                      <span className="terminal-bullet" />
                      <span className="terminal-line-body">{sanitizeTerminalLine(line)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {hasAction ? (
                <>
                  <div className="terminal-divider" />

                  <div className="terminal-section">
                    <div className="terminal-section-title">ACTION PLAN</div>
                    <div className="terminal-block">
                      {actionItems.map((item, index) => (
                        <div key={`${reportCard.key}-plan-${index}-${item.label || 'line'}`} className="terminal-line">
                          <span className="terminal-bullet" />
                          <span className="terminal-line-body">
                            {item.label && item.label !== `${index + 1}` ? (
                              <>
                                <span className="terminal-line-label">{sanitizeTerminalLine(item.label)}</span>
                                <span className="terminal-line-sep">:</span>
                              </>
                            ) : null}
                            {sanitizeTerminalLine(item.text)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    )
  }

  const renderReportCommandDeck = ({
    mode = 'archive',
    cards = [],
    selectedReport = null,
    terminalSections = null,
    onSelect = null,
    actionLabel = 'IDLE',
    decisionLabel = '',
    decisionTone = 'neutral',
    tickerValue = '----',
    loadingLabel = 'Awaiting run',
    reportDate = '--',
    reportTime = '--',
    depthLabel = '--',
    modelsMeta = null,
    readerStatus = 'AWAITING REPORT',
    emptyTitle = 'AWAITING REPORT DATA',
    emptyCopy = 'Select a completed report when it appears in the timeline.',
    showTickerBesideAction = true,
    allowFinalStatus = false,
  } = {}) => (
    (() => {
      const normalizedDecision = String(decisionLabel || '').trim().toUpperCase()
      const normalizedAction = String(actionLabel || '').trim().toUpperCase()
      const actionTokenMatch = normalizedAction.match(/\b(BUY|SELL|HOLD)\b/)
      const actionToken = actionTokenMatch ? actionTokenMatch[1] : ''
      const resolvedTerminalAction =
        normalizedDecision === 'BUY' || normalizedDecision === 'SELL' || normalizedDecision === 'HOLD'
          ? normalizedDecision
          : actionToken
      const hasTerminalAction = resolvedTerminalAction === 'BUY' || resolvedTerminalAction === 'SELL' || resolvedTerminalAction === 'HOLD'
      const resolvedStatusLabel =
        mode === 'live'
          ? (
            allowFinalStatus
              ? (hasTerminalAction ? resolvedTerminalAction : (normalizedDecision === 'COMPLETED' || normalizedAction === 'COMPLETED' ? 'COMPLETED' : 'IN PROGRESS'))
              : 'IN PROGRESS'
          )
          : mode === 'idle'
            ? 'IDLE'
            : (normalizedDecision || 'IDLE')
      const statusTone =
        resolvedStatusLabel === 'BUY' ? 'buy'
          : resolvedStatusLabel === 'SELL' ? 'sell'
            : resolvedStatusLabel === 'HOLD' ? 'hold'
              : resolvedStatusLabel === 'IN PROGRESS' ? 'progress'
                : 'idle'

      return (
    <div className={`reports-command-deck reports-command-deck--${mode}`}>
      <header className="reports-command-header">
        <div className="reports-command-header__identity">
          <div className="reports-command-header__split">
            <div className="reports-command-header__split-left">
              <span className="reports-command-header__split-label">TICKER</span>
              <span className="reports-command-header__ticker reports-command-header__ticker--primary">
                ${tickerValue}
              </span>
            </div>
            <div className={`reports-command-header__status-card is-${statusTone}`}>
              <span className="reports-command-header__status-label">FINAL STATUS</span>
              <span className="reports-command-header__status-value">{resolvedStatusLabel}</span>
            </div>
          </div>
        </div>

        <div className="reports-command-header__metrics" aria-label="TradingAgents report metrics">
          <div className="reports-command-metric">
            <span className="reports-command-metric__label">DATE</span>
            <span className="reports-command-metric__value reports-command-metric__value--meta">{reportDate || '--'}</span>
          </div>
          <div className="reports-command-metric">
            <span className="reports-command-metric__label">TIME</span>
            <span className="reports-command-metric__value reports-command-metric__value--meta">{reportTime || '--'}</span>
          </div>
          <div className="reports-command-metric">
            <span className="reports-command-metric__label">DEPTH</span>
            <span className="reports-command-metric__value reports-command-metric__value--meta">{depthLabel || '--'}</span>
          </div>
          <div className="reports-command-metric reports-command-metric--wide">
            <span className="reports-command-metric__label">MODELS</span>
            <span className="reports-command-metric__value reports-command-metric__value--meta reports-command-model-stack" title={modelsMeta?.title || '--'}>
              <span className="reports-command-model-line">
                <span className="reports-command-model-prefix">Q</span>
                <span className="reports-command-model-name">{modelsMeta?.quick || '--'}</span>
              </span>
              <span className="reports-command-model-line">
                <span className="reports-command-model-prefix">D</span>
                <span className="reports-command-model-name">{modelsMeta?.deep || '--'}</span>
              </span>
            </span>
          </div>
        </div>

        <div className="reports-command-header__logo" aria-hidden="true">
          <img
            src={`/ticker_icons/${tickerValue}.png`}
            alt=""
            onError={(e) => {
              e.target.onerror = null;
              e.target.src = '/ticker_icons/GENERIC.png';
              e.target.style.filter = 'grayscale(1) brightness(1.5)';
            }}
            className="pixel-ticker-logo-giant"
          />
        </div>
      </header>

      <div className="reports-command-body">
        <aside className="reports-command-timeline" aria-label="Agent report timeline">
          <header className="reports-command-section-title">
            <span>AGENT TIMELINE</span>
            <span>{readerStatus}</span>
          </header>
          <div className="tactical-summaries-list tactical-summaries-list--live reports-command-timeline__list">
            {cards.map((summary) => renderSummaryCard(summary, {
              selected: selectedReport?.key === summary.key,
              onSelect,
            }))}
          </div>
        </aside>

        <main className="reports-command-reader" aria-label="Selected full report">
          <header className="reports-command-section-title reports-command-section-title--reader">
            <span>REPORT READER</span>
            <span>{selectedReport?.label || loadingLabel}</span>
          </header>
          {selectedReport ? (
            renderTerminalWindow(selectedReport, terminalSections, {
              windowClassName: 'tactical-terminal-window--live-spotlight reports-command-reader__terminal',
              bodyClassName: 'tactical-terminal__body--live-spotlight',
            })
          ) : (
            <div className="reports-command-reader__empty">
              <span className="reports-command-reader__empty-title">{emptyTitle}</span>
              <span className="reports-command-reader__empty-copy">{emptyCopy}</span>
            </div>
          )}
        </main>
      </div>
    </div>
      )
    })()
  )

  const tacticalLeftColumn = (
    <div className="tactical-dashboard__column tactical-dashboard__column--left">
      <div className="tactical-hero-verdict">
        <div className="verdict-columns">
          <div className="verdict-col verdict-col--left">
            <h2 className="verdict-action">{recommendation}</h2>
            <div className="verdict-ticker-stack">
              <span className="verdict-ticker-primary">${tacticalTicker}</span>
            </div>
            <div className="verdict-stats-v2 verdict-stats-inline">
              <div className="stat-entry">
                <span className="stat-label">STATS</span>
                <span className="stat-value">+{tacticalMarketCap}</span>
              </div>
              <div className="stat-entry">
                <span className="stat-label">RISKS</span>
                <span className="stat-value">+{tacticalVolatility}</span>
              </div>
            </div>
          </div>

          <div className="verdict-col verdict-col--right">
            <div className="verdict-meta-block">
              <div className="verdict-meta-placeholder">
                {archiveAttemptLabel ? `ATTEMPT ${archiveAttemptLabel}` : ''}
                {archiveTimestamp ? (archiveAttemptLabel ? ` | ${archiveTimestamp}` : archiveTimestamp) : ''}
              </div>
            </div>
            <div className="verdict-logo-giant">
              <img
                src={`/ticker_icons/${tacticalTicker}.png`}
                alt={tacticalTicker}
                onError={(e) => {
                  e.target.onerror = null;
                  e.target.src = '/ticker_icons/GENERIC.png';
                  e.target.style.filter = 'grayscale(1) brightness(1.5)';
                }}
                className="pixel-ticker-logo-giant"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="tactical-summaries-window">
        <header className="tactical-summaries-header">
          <div className="tactical-summaries-header__strip"></div>
          <span className="tactical-summaries-header__title">AGENT SUMMARIES</span>
        </header>

        <div className="tactical-summaries-list">
          {archiveReportCards.map((summary) => renderSummaryCard(summary, {
            selected: selectedArchiveReport?.key === summary.key,
            onSelect: handleSelectArchiveReport,
          }))}
        </div>
      </div>
    </div>
  )

  return (
    <section className={`final-reports-panel${showLiveRun ? ' is-live-run' : ''}`}>
      {/* Corner Ornaments */}
      <div className="final-reports-panel__corner final-reports-panel__corner--tl"></div>
      <div className="final-reports-panel__corner final-reports-panel__corner--tr"></div>
      <div className="final-reports-panel__corner final-reports-panel__corner--bl"></div>
      <div className="final-reports-panel__corner final-reports-panel__corner--br"></div>

      {!showLiveRun ? (
        <header className="final-reports-panel__header">
          <span className="final-reports-panel__signal-dot" />
          <div className="final-reports-panel__title-wrap">
            <span className="final-reports-panel__title">{panelHeaderLabel}</span>
          </div>
        </header>
      ) : null}

      {showLiveRun ? (
        <div className="final-reports-panel__live">
          <div className="final-reports-panel__live-body final-reports-panel__live-body--grid">
            {renderReportCommandDeck({
              mode: 'live',
              cards: liveReportCards,
              selectedReport: selectedLiveReport,
              terminalSections: liveTerminalSections,
              onSelect: handleSelectLiveReport,
              actionLabel: `$${liveHeroTicker}`,
              decisionLabel: hasFinalDecisionSignal && liveHeroAction ? liveHeroAction : recommendation,
              decisionTone: getActionTone((hasFinalDecisionSignal && liveHeroAction) ? liveHeroAction : recommendation),
              tickerValue: liveHeroTicker,
              allowFinalStatus: false,
              showTickerBesideAction: false,
              loadingLabel: `LOADING ${liveCurrentLabel}`,
              reportDate: liveReportDate,
              reportTime: liveReportTime,
              depthLabel: liveDepthLabel,
              modelsMeta: liveModelsMeta,
              readerStatus: liveReaderStatus,
              emptyTitle: 'AWAITING FIRST FULL REPORT',
              emptyCopy: 'The full canonical report will lock here as soon as the first agent completes.',
            })}
          </div>
        </div>
      ) : liveTerminal ? (
        <div className="final-reports-panel__terminal">
          <div className="final-reports-panel__terminal-title">
            [ {liveTerminal.status} ]
          </div>
          <div className="final-reports-panel__terminal-ticker">{liveTerminal.ticker || '---'}</div>
          <div className="final-reports-panel__terminal-agent">
            {liveTerminal.agent}
          </div>
          <div className="final-reports-panel__terminal-copy">
            <div>Pipeline {liveTerminal.status.toLowerCase()}.</div>
            {liveTerminal.errorCode ? <div>Code: {liveTerminal.errorCode}</div> : null}
            {liveTerminal.errorMessage ? <div>{liveTerminal.errorMessage}</div> : null}
            {liveTerminal.failedStage || liveTerminal.failedAgent ? (
              <div>
                {liveTerminal.failedStage ? `Stage: ${liveTerminal.failedStage}` : ''}
                {liveTerminal.failedStage && liveTerminal.failedAgent ? ' | ' : ''}
                {liveTerminal.failedAgent ? `Agent: ${liveTerminal.failedAgent}` : ''}
              </div>
            ) : null}
            {liveTerminal.attempt && liveTerminal.maxAttempts ? (
              <div>Attempts: {liveTerminal.attempt}/{liveTerminal.maxAttempts}</div>
            ) : null}
          </div>
          <div className="final-reports-panel__terminal-copy" style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              onClick={handleRetryRun}
              disabled={isRetryingRun}
              style={{ cursor: isRetryingRun ? 'wait' : 'pointer' }}
            >
              {isRetryingRun ? 'Retrying...' : 'Retry Run'}
            </button>
            {retryError ? <span>{retryError}</span> : null}
          </div>
        </div>
      ) : showCompletedLiveFallback ? (
        <div className="final-reports-panel__live">
          <div className="final-reports-panel__live-body final-reports-panel__live-body--grid">
            {renderReportCommandDeck({
              mode: 'live',
              cards: liveReportCards,
              selectedReport: selectedLiveReport,
              terminalSections: liveTerminalSections,
              onSelect: handleSelectLiveReport,
              actionLabel: `$${liveHeroTicker || ticker || '----'}`,
              decisionLabel: hasFinalDecisionSignal && liveHeroAction ? liveHeroAction : recommendation,
              decisionTone: getActionTone((hasFinalDecisionSignal && liveHeroAction) ? liveHeroAction : recommendation),
              tickerValue: liveHeroTicker || tacticalTicker,
              allowFinalStatus: true,
              showTickerBesideAction: false,
              loadingLabel: selectedLiveReport ? `FULL REPORT ${selectedLiveReport.label}` : 'FINAL REPORTS READY',
              reportDate: liveReportDate || archiveReportDate || '--',
              reportTime: liveReportTime || archiveReportTime || '--',
              depthLabel: liveDepthLabel || archiveDepthLabel || '--',
              modelsMeta: liveModelsMeta || archiveModelsMeta || null,
              readerStatus: selectedLiveReport
                ? `${selectedLiveReport.index}/12 ${formatSummaryStatus(selectedLiveReport.status)}`
                : '12/12 RECEIVED',
              emptyTitle: 'REPORTS READY',
              emptyCopy: 'Run completed. Select a report from the timeline.',
            })}
          </div>
        </div>
      ) : showArchiveDashboard ? (
        <div className="final-reports-panel__live final-reports-panel__live--archive">
          <div className="final-reports-panel__live-body final-reports-panel__live-body--grid">
            {renderReportCommandDeck({
              mode: 'archive',
              cards: archiveReportCards,
              selectedReport: selectedArchiveReport,
              terminalSections: archiveTerminalSections,
              onSelect: handleSelectArchiveReport,
              actionLabel: `$${tacticalTicker}`,
              decisionLabel: recommendation,
              decisionTone: getActionTone(recommendation),
              tickerValue: tacticalTicker,
              loadingLabel: selectedArchiveReport ? `FULL REPORT ${selectedArchiveReport.label}` : 'ARCHIVE REPORT',
              reportDate: archiveReportDate,
              reportTime: archiveReportTime,
              depthLabel: archiveDepthLabel,
              modelsMeta: archiveModelsMeta,
              readerStatus: selectedArchiveReport ? `${selectedArchiveReport.index}/12 ${formatSummaryStatus(selectedArchiveReport.status)}` : 'ARCHIVE READY',
              emptyTitle: 'NO ARCHIVE REPORT SELECTED',
              emptyCopy: 'Choose a completed report from the timeline to inspect the full canonical text.',
            })}
          </div>
        </div>
      ) : showIdleDashboard ? (
        <div className="final-reports-panel__live final-reports-panel__live--idle">
          <div className="final-reports-panel__live-body final-reports-panel__live-body--grid">
            {renderReportCommandDeck({
              mode: 'idle',
              cards: archiveReportCards,
              selectedReport: null,
              terminalSections: null,
              onSelect: handleSelectArchiveReport,
              actionLabel: `$${ticker || '----'}`,
              tickerValue: ticker,
              showTickerBesideAction: false,
              loadingLabel: 'AWAITING RUN',
              reportDate: '--',
              reportTime: '--',
              depthLabel: '--',
              modelsMeta: null,
              readerStatus: 'SYSTEM IDLE',
              emptyTitle: 'AWAITING LIVE REPORTS',
              emptyCopy: 'Start a TradingAgents run. Full reports will appear here without changing the floor layout.',
            })}
          </div>
        </div>
      ) : (
        <div className="final-reports-panel__live final-reports-panel__live--archive">
          <div className="final-reports-panel__live-body final-reports-panel__live-body--grid">
            {renderReportCommandDeck({
              mode: 'archive',
              cards: archiveReportCards,
              selectedReport: selectedArchiveReport,
              terminalSections: archiveTerminalSections,
              onSelect: handleSelectArchiveReport,
              actionLabel: `$${tacticalTicker}`,
              decisionLabel: recommendation,
              decisionTone: getActionTone(recommendation),
              tickerValue: tacticalTicker,
              loadingLabel: selectedArchiveReport ? `FULL REPORT ${selectedArchiveReport.label}` : 'ARCHIVE REPORT',
              reportDate: archiveReportDate,
              reportTime: archiveReportTime,
              depthLabel: archiveDepthLabel,
              modelsMeta: archiveModelsMeta,
              readerStatus: selectedArchiveReport ? `${selectedArchiveReport.index}/12 ${formatSummaryStatus(selectedArchiveReport.status)}` : 'ARCHIVE READY',
              emptyTitle: 'NO ARCHIVE REPORT SELECTED',
              emptyCopy: 'Choose a completed report from the timeline to inspect the full canonical text.',
            })}
          </div>
        </div>
      )}
    </section>

  )
}
