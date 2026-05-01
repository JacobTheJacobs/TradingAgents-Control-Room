import React, { useMemo } from 'react'
import { motion } from 'framer-motion'
import './MetroFlow.css'
import { useTradingFloor } from '../context/TradingFloorContext'
import { FaBalanceScale, FaBolt, FaChartBar, FaSearch, FaShieldAlt } from 'react-icons/fa'
import {
  normalizeTradingAgentId,
  TRADING_AGENT_STEP_NUM_BY_AGENT,
  TRADING_AGENT_WORKFLOW_STEPS,
} from '../config/tradingAgentsRoster'

// ================================================================
// 5-STEP METRO FLOW — Enhanced 8-bit HUD
// Compact game-style header + solid pixel stations + dotted track
// ================================================================

const REPORT_STATIONS = [
  { id: '1_analysts', label: 'ANALYSTS', icon: FaChartBar, agent: 'Analyst Team', threshold: 1 },
  { id: '2_research', label: 'RESEARCH', icon: FaSearch, agent: 'Research Team', threshold: 2 },
  { id: '3_trader', label: 'TRADER', icon: FaBolt, agent: 'Trader', threshold: 3 },
  { id: '4_risk', label: 'RISK', icon: FaShieldAlt, agent: 'Risk Management', threshold: 4 },
  { id: '5_portfolio', label: 'PORTFOLIO', icon: FaBalanceScale, agent: 'Portfolio Management', threshold: 5 },
];

// Legacy exports consumed by AnimationSyncContext and others
export const PHASES = REPORT_STATIONS.map(s => ({ id: s.id, label: s.label, icon: s.icon }));
export const UNIFIED_PHASES = PHASES;
export const PHASE_ORDER = REPORT_STATIONS.map(s => s.id);
export const TA_PHASES = { quick: PHASES, standard: PHASES, deep: PHASES };

const TA_AGENT_PHASES = [
  { id: 1, label: 'ANALYSTS', desc: 'Analyst Team' },
  { id: 2, label: 'RESEARCH', desc: 'Research Team' },
  { id: 3, label: 'TRADER', desc: 'Trader' },
  { id: 4, label: 'RISK', desc: 'Risk Management' },
  { id: 5, label: 'PORTFOLIO', desc: 'Portfolio Management' },
];

const MetroFlow = ({
  currentTicker = '',
  compact = false,
  showDetails = true,
}) => {
  const { state } = useTradingFloor();
  const { taRunStats, pipelineState } = state;

  const ticker = pipelineState?.ticker || pipelineState?.current_ticker || currentTicker || '';
  const reports = taRunStats.reports || {};
  const rawPhaseNum = Number(pipelineState?.phase_num || pipelineState?.current_phase || 0);
  const phaseLabel = String(pipelineState?.phase || pipelineState?.sub_phase || '').toUpperCase();
  const agentId = normalizeTradingAgentId(
    pipelineState?.current_step ||
    pipelineState?.agent ||
    pipelineState?.agent_display_name
  );
  const derivedFromAgent = agentId ? TRADING_AGENT_STEP_NUM_BY_AGENT[agentId] : 0;
  const derivedFromLabel = TRADING_AGENT_WORKFLOW_STEPS.find((step) => (
    step.key === phaseLabel ||
    step.shortLabel === phaseLabel ||
    step.label.toUpperCase() === phaseLabel
  ))?.step || 0;
  const activePhaseNum = rawPhaseNum || derivedFromAgent || derivedFromLabel;

  const humanizedStatus = String(pipelineState?.action || pipelineState?.status || '')
    .replace(/_/g, ' ').trim().toUpperCase();

  const currentIndex = useMemo(() => {
    if (!activePhaseNum || activePhaseNum === 0) return -1;
    if (activePhaseNum > 0 && activePhaseNum <= 5) return activePhaseNum - 1;
    return 4;
  }, [activePhaseNum]);

  const toFiniteNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const resolveElapsedSeconds = ({ startTime, endTime, explicitElapsed, running }) => {
    const explicit = toFiniteNumber(explicitElapsed);
    if (!running && explicit != null && explicit >= 0) return Math.round(explicit);

    const startMs = Date.parse(startTime || '');
    if (!Number.isFinite(startMs)) return explicit != null && explicit >= 0 ? Math.round(explicit) : 0;

    const endMs = running
      ? Date.now()
      : (Date.parse(endTime || '') || Date.now());
    const elapsedSec = Math.floor((endMs - startMs) / 1000);
    if (!Number.isFinite(elapsedSec) || elapsedSec < 0) {
      return explicit != null && explicit >= 0 ? Math.round(explicit) : 0;
    }
    return elapsedSec;
  };

  const hasTokenTelemetry = Boolean(taRunStats?.tokenTelemetrySeen);
  const resolvedTokensUp = hasTokenTelemetry
    ? Math.max(
      toFiniteNumber(taRunStats.tokensUp) ?? 0,
      toFiniteNumber(pipelineState?.tokens_in) ?? 0,
    )
    : null;
  const resolvedTokensDown = hasTokenTelemetry
    ? Math.max(
      toFiniteNumber(taRunStats.tokensDown) ?? 0,
      toFiniteNumber(pipelineState?.tokens_out) ?? 0,
    )
    : null;

  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (!taRunStats.startTime || !taRunStats.running) {
      setElapsed(resolveElapsedSeconds({
        startTime: taRunStats.startTime,
        endTime: taRunStats.endTime || taRunStats.upstreamGeneratedAt || pipelineState?.timestamp,
        explicitElapsed: taRunStats.elapsed,
        running: Boolean(taRunStats.running),
      }));
      return;
    }
    const updateElapsed = () => {
      const nextElapsed = resolveElapsedSeconds({
        startTime: taRunStats.startTime,
        endTime: null,
        explicitElapsed: taRunStats.elapsed,
        running: true,
      });
      setElapsed(Number.isFinite(nextElapsed) && nextElapsed >= 0 ? nextElapsed : 0);
    };
    updateElapsed();
    const interval = setInterval(() => {
      updateElapsed();
    }, 1000);
    return () => clearInterval(interval);
  }, [taRunStats.startTime, taRunStats.endTime, taRunStats.running, taRunStats.elapsed, taRunStats.upstreamGeneratedAt, pipelineState?.timestamp]);

  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const reportSectionsTotal = taRunStats.reportSectionsTotal || 12;
  const reportsComplete =
    reportSectionsTotal > 0 &&
    taRunStats.reportSectionsCompleted >= reportSectionsTotal;
  const statsComplete =
    taRunStats.completed === true ||
    ['complete', 'completed'].includes(String(taRunStats.status || '').toLowerCase());
  const pipelineComplete =
    String(pipelineState?.phase || '').toUpperCase() === 'COMPLETE' ||
    String(pipelineState?.status || '').toUpperCase() === 'COMPLETE';
  const completedOverride = statsComplete || pipelineComplete || reportsComplete;
  const isAllDone = completedOverride || (!taRunStats.running && reportsComplete);
  const isRunning = taRunStats.running;
  const reportsCount = completedOverride
    ? REPORT_STATIONS.length
    : Math.min(Object.keys(reports).length, REPORT_STATIONS.length);
  const reportSectionsCount = Math.min(
    completedOverride
      ? reportSectionsTotal
      : Math.max(
        Number(taRunStats.reportSectionsCompleted || 0),
        Object.keys(taRunStats.reportSections || {}).length,
      ),
    taRunStats.reportSectionsTotal || 12,
  );
  const agentsTotal = taRunStats.agentsTotal || 12;
  const agentsDone = completedOverride
    ? agentsTotal
    : (taRunStats.agentsCompleted || 0);
  const formatTokens = (up, down) => {
    const hasUp = Number.isFinite(up);
    const hasDown = Number.isFinite(down);
    if (!hasUp && !hasDown) return '--';
    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n);
    return `${fmt(hasUp ? up : 0)}↑ ${fmt(hasDown ? down : 0)}↓`;
  };

  return (
    <div className={`mf ${compact ? 'mf--compact' : ''}`}>
      {/* ── Ornate JRPG Container Decorations ── */}
      <div className="mf-corner mf-corner--tl" />
      <div className="mf-corner mf-corner--tr" />

      {/* ── ROW 1: COMPACT HUD HEADER (single row, inline badges) ── */}
      <div className="mf-hud">
        <span className={`mf-badge ${isRunning ? 'mf-badge--run' : isAllDone ? 'mf-badge--done' : 'mf-badge--idle'}`}>
          <span className="mf-badge__dot" />
          {isRunning ? 'LIVE' : isAllDone ? 'DONE' : 'IDLE'}
        </span>

        <motion.span key={ticker} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mf-ticker">
          {ticker || '---'}
        </motion.span>

        <div className="mf-hud__stats">
          <span className="mf-stat">AGENTS <b>{agentsDone}/{agentsTotal}</b></span>
          <span className="mf-stat">LLM <b className="mf-val--amber">{taRunStats.llmCalls || 0}</b></span>
          <span className="mf-stat">TOOLS <b>{taRunStats.toolCalls || 0}</b></span>
          <span className="mf-stat">REPORTS <b className={isAllDone ? 'mf-val--green' : ''}>{reportSectionsCount}/{taRunStats.reportSectionsTotal || 12}</b></span>
          <span className="mf-stat mf-timer">TIME {fmt(elapsed)}</span>
          <span className="mf-stat">TOKENS <b>{formatTokens(resolvedTokensUp, resolvedTokensDown)}</b></span>
        </div>

        {isRunning && <span className="mf-pulse" />}
      </div>

      {/* ── ROW 2: LINEAR QUEST PATH ── */}
      <div className="mf-pipeline-linear">
        {/* The Progress Path Group (Centered Track) */}
        <div className="mf-path-group">
          <div className="mf-path-track" />

          {/* Animated Spirit Progress */}
          <motion.div
            className="mf-path-spirit"
            initial={{ width: '0%' }}
            animate={{
              width: `${(reportsCount > 0 ? (reportsCount - 1) / (REPORT_STATIONS.length - 1) : 0) * 100}%`
            }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          />
        </div>

        {REPORT_STATIONS.map((station, idx) => {
          const displayIndex = completedOverride ? REPORT_STATIONS.length - 1 : currentIndex;
          const isDone = completedOverride || displayIndex > idx || isAllDone;
          const isActive = !completedOverride && idx === displayIndex && isRunning;
          const status = isDone ? 'done' : isActive ? 'active' : 'pending';

          return (
            <div key={station.id} className={`mf-node mf-node--${status}`}>
              {/* Badge Icon */}
              <div className="mf-node__shield">
                {isActive && (
                  <div className="mf-node__glow" />
                )}
                <span className="mf-node__icon">
                  <station.icon className="mf-node__icon-glyph" aria-hidden="true" />
                </span>
                {isDone && <span className="mf-node__check">✓</span>}
              </div>

              {/* Label */}
              <div className="mf-node__label">{station.label}</div>
            </div>
          );
        })}
      </div>

      {/* ── ROW 3: MINI STATUS LOG ── */}
      {showDetails && (
        <div className="mf-status-mini">
          <span className="mf-status__phase">
            PHASE: <b>{activePhaseNum > 0 ? TA_AGENT_PHASES[activePhaseNum - 1]?.label : 'IDLE'}</b>
          </span>
          <span className="mf-status__log">
            {taRunStats.decision
              ? `▸ DECISION: ${taRunStats.decision}`
              : isRunning
                ? `▸ ${humanizedStatus || 'ANALYZING...'}`
                : isAllDone
                  ? '▸ PIPELINE COMPLETE'
                  : '▸ AWAITING ENGINE...'}
          </span>
        </div>
      )}
    </div>
  );
};

export default MetroFlow;
