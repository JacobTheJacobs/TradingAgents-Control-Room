import {
  TRADING_AGENT_BY_ID,
  TRADING_AGENT_REPORT_SECTIONS,
  TRADING_AGENT_WORKFLOW_STEPS,
  normalizeTradingAgentName,
} from '../config/tradingAgentsRoster'

export const TRADING_AGENT_PHASE_DEFS = TRADING_AGENT_WORKFLOW_STEPS.map((step) => ({
  key: step.key,
  label: step.label,
  shortLabel: step.shortLabel,
  agents: step.agents.map((agentId) => TRADING_AGENT_BY_ID[agentId]?.name || agentId),
}))

const TRADING_AGENT_REPORT_DEFS = TRADING_AGENT_REPORT_SECTIONS.map((section) => ({
  key: section.key,
  label: section.label,
  shortLabel: section.shortLabel,
  agents: section.agents.map((agentId) => TRADING_AGENT_BY_ID[agentId]?.name || agentId),
}))

const AGENT_SHORT_LABELS = {
  'Market Analyst': 'Market',
  'Social Analyst': 'Social',
  'News Analyst': 'News',
  'Fundamentals Analyst': 'Fund',
  'Bull Researcher': 'Bull',
  'Bear Researcher': 'Bear',
  'Research Manager': 'Mgr',
  Trader: 'Trader',
  'Aggressive Analyst': 'Agg',
  'Conservative Analyst': 'Cons',
  'Neutral Analyst': 'Neutral',
  'Risk Judge': 'Judge',
}

export const TRADE_DECISION_EVENT = 'TRADE_DECISION_PACKAGE_UPDATED'

export function isCompletedTradingAgentsRun(run) {
  const status = String(run?.run_status || run?.status || '').toUpperCase()
  return status === 'COMPLETED' || status === 'COMPLETE'
}

const normalizeRunDateValue = (value) => {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/i.test(raw)) {
    return `${raw}Z`
  }
  return raw
}

const parseRunDateMs = (value) => {
  const normalized = normalizeRunDateValue(value)
  if (!normalized) return 0
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : 0
}

export function getRunTimestampMs(run) {
  if (!run) return 0
  return (
    parseRunDateMs(run.completed_at) ||
    parseRunDateMs(run.updated_at) ||
    parseRunDateMs(run.created_at) ||
    parseRunDateMs(run?.raw_state?.generated_at) ||
    0
  )
}

export function isLegacyTradingAgentsRun(run) {
  if (!run) return true
  const provider = String(run?.llm_provider || run?.raw_state?.llm_provider || '').trim()
  const quickModel = String(run?.quick_model || run?.raw_state?.quick_model || '').trim()
  const deepModel = String(run?.deep_model || run?.raw_state?.deep_model || '').trim()
  return !provider && !quickModel && !deepModel
}

export function sortRunsNewestFirst(runs) {
  return [...(Array.isArray(runs) ? runs : [])].sort((a, b) => {
    const delta = getRunTimestampMs(b) - getRunTimestampMs(a)
    if (delta !== 0) return delta
    return String(b?.run_id || '').localeCompare(String(a?.run_id || ''))
  })
}

export function selectLatestCompletedRun(runs, { preferModern = true } = {}) {
  const completed = sortRunsNewestFirst(runs).filter((run) => isCompletedTradingAgentsRun(run))
  if (completed.length === 0) return null
  if (!preferModern) return completed[0]
  const modern = completed.find((run) => !isLegacyTradingAgentsRun(run))
  return modern || completed[0]
}

export function formatRunTime(value) {
  if (!value) return '--'
  try {
    const normalized = (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/i.test(value.trim()) &&
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())
    )
      ? `${value.trim()}Z`
      : value
    return new Date(normalized).toLocaleTimeString()
  } catch {
    return value
  }
}

export function compactRunText(value, limit = 220) {
  if (!value) return '--'
  const normalized = String(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<tool_call>[\s\S]*/gi, ' ')
    .replace(/\{"name":[\s\S]*?(\}|(?=\n|$))/gi, ' ') // Strip JSON tool calls (even if partial)
    .replace(/\{"thought":[\s\S]*?(\}|(?=\n|$))/gi, ' ') // Strip thought blocks
    .replace(/\{[^{}]{0,160}\}/g, ' ')
    .replace(/(\*\*[^*]+\*\*|##\s+[^\n]+|>\s+[^\n]+)/g, ' ') // Remove markdown headers/bolds/quotes
    .replace(/[|*_`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return '--'
  const sentences = (normalized.match(/[^.!?]+[.!?]?/g) || []).slice(0, 2).join(' ').trim() || normalized
  return sentences.length > limit ? `${sentences.slice(0, limit - 3).trim()}...` : sentences
}

export function getDecisionSummary(run) {
  if (!run) return '--'
  const rawReasoning = String(run.reasoning || '').trim()
  const reasoningWeak = !rawReasoning || /^[a-z]/.test(rawReasoning) || /^concerns\b/i.test(rawReasoning)
  const preferred = reasoningWeak ? run.prediction : run.reasoning
  const text = preferred || run.prediction || run.reasoning
  return compactRunText(text, 260)
}

export function getFullPrediction(run) {
  return String(run?.report_excerpt || run?.raw_state?.final_trade_decision || run?.prediction || run?.reasoning || '').trim()
}

export function getRunStateLabel(run) {
  if (!run) return '--'
  const approvalStatus = String(run.approval_status || '')
  const executionMode = String(run.execution_mode || '')

  if (approvalStatus === 'EXECUTED') return 'EXECUTED'
  if (approvalStatus === 'APPROVED') return 'EXECUTING'
  if (approvalStatus === 'REJECTED') return 'REJECTED'
  if (approvalStatus === 'FAILED') return 'FAILED'
  if (approvalStatus === 'STALE') return 'STALE'
  if (executionMode) return executionMode
  if (approvalStatus) return approvalStatus
  return '--'
}

export function standardizeAction(action) {
  const raw = String(action || '--').toUpperCase().trim()
  if (raw === 'ADD') return 'BUY'
  if (raw === 'REDUCE' || raw === 'LIQUIDATE') return 'SELL'
  return raw
}

export function getRunActionLabel(run) {
  return standardizeAction(run?.recommended_action || run?.model_action)
}

const extractSentence = (value, limit = 180) => {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[|*_`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return '--'

  const candidates = text.match(/[^.!?]+[.!?]?/g) || [text]
  const impactful = candidates.find((sentence) => (
    /\b(thesis|risk|catalyst|conviction|position|sizing|drawdown|reward|downside|upside)\b/i.test(sentence)
  )) || candidates[0]

  const trimmed = impactful.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3).trim()}...` : trimmed
}

export function getPortfolioManagerOqs(run) {
  if (!run) return '--'

  const reports = Array.isArray(run?.agent_reports) ? run.agent_reports : []
  const judgeReport = reports.find((report) => normalizeTradingAgentName(report?.agent) === 'Risk Judge')
  const judgeText =
    judgeReport?.summary ||
    judgeReport?.reasoning ||
    judgeReport?.report ||
    run?.report_excerpt ||
    run?.raw_state?.final_trade_decision ||
    run?.prediction ||
    run?.reasoning

  return extractSentence(judgeText, 190)
}

export function buildTradingAgentsPhaseSummaries(run) {
  const reports = Array.isArray(run?.agent_reports) ? run.agent_reports : []
  const byAgent = new Map(reports.map((report) => [normalizeTradingAgentName(report?.agent) || report?.agent, report]))

  return TRADING_AGENT_REPORT_DEFS.map((phaseDef) => {
    const matched = phaseDef.agents
      .map((agentName) => byAgent.get(agentName))
      .filter(Boolean)

    if (matched.length === 0) {
      if (phaseDef.key === 'final_trade_decision') {
        const fallback = getFullPrediction(run)
        if (fallback && fallback !== '--') {
          return {
            key: phaseDef.key,
            label: phaseDef.label,
            shortLabel: phaseDef.shortLabel,
            text: compactRunText(fallback, 120),
            hasReport: true,
          }
        }
      }
      return {
        key: phaseDef.key,
        label: phaseDef.label,
        shortLabel: phaseDef.shortLabel,
        text: 'NO REPORT',
        hasReport: false,
      }
    }

    if (matched.length === 1) {
      return {
        key: phaseDef.key,
        label: phaseDef.label,
        shortLabel: phaseDef.shortLabel,
        text: compactRunText(matched[0].summary || matched[0].reasoning || matched[0].report, 120),
        hasReport: true,
      }
    }

    return {
      key: phaseDef.key,
      label: phaseDef.label,
      shortLabel: phaseDef.shortLabel,
      text: compactRunText(
        matched
          .map((report) => `${AGENT_SHORT_LABELS[report.agent] || report.agent}: ${report.summary || report.reasoning || 'NO REPORT'}`)
          .join(' '),
        180,
      ),
      hasReport: true,
    }
  })
}
