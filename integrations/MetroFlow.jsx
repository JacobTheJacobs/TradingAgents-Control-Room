/**
 * MetroFlow Component - Dynamic Two-Layer Pipeline Visualization
 * 
 * This is a DESIGN EXAMPLE showing how to implement Metro Flow with:
 * 1. Research depth decides which phases exist
 * 2. Each phase has dynamic substeps that change by depth
 */

import React, { useMemo } from 'react';

// =============================================================================
// PIPELINE CONFIG (SAME AS PYTHON VERSION)
// =============================================================================

export const PIPELINE_CONFIG = {
  // ORIGINAL 8-PHASE PIPELINE
  original: {
    quick: [
      { id: 'regime', label: 'REGIME', icon: '🌐', steps: ['market regime'], agents: ['regime_detector'] },
      { id: 'scout', label: 'SCOUT', icon: '🔍', steps: ['heuristic scan'], agents: ['scout'] },
      { id: 'agents', label: 'AGENTS', icon: '👥', steps: ['technical', 'fundamental'], agents: ['Technical', 'Fundamental'] },
      { id: 'oracle', label: 'ORACLE', icon: '🔮', steps: ['synthesis'], agents: ['oracle'] },
      { id: 'portfolio', label: 'PORTFOLIO', icon: '💰', steps: ['execute'], agents: ['portfolio_manager'] },
    ],
    standard: [
      { id: 'regime', label: 'REGIME', icon: '🌐', steps: ['market regime'], agents: ['regime_detector'] },
      { id: 'scout', label: 'SCOUT', icon: '🔍', steps: ['heuristic scan', 'LLM ranking'], agents: ['scout'] },
      { id: 'pre_mortem', label: 'PRE-MORTEM', icon: '💭', steps: ['scenario analysis', 'veto check'], agents: ['risk_analyst'] },
      { id: 'war_room', label: 'WAR ROOM', icon: '🎯', steps: ['macro context', 'sentiment brief'], agents: ['macro', 'sentiment'] },
      { id: 'agents', label: 'AGENTS', icon: '👥', steps: ['technical', 'fundamental', 'sentiment', 'news', 'risk', 'growth', 'value', 'momentum', 'contrarian', 'macro'], agents: ['Warren', 'Charlie', 'Technical', 'Fundamental', 'Sentiment', 'Risk', 'Momentum', 'Value', 'Growth', 'Contrarian'] },
      { id: 'inquisition', label: 'INQUISITION', icon: '⚖️', steps: ['vote counting', 'consensus check'], agents: [] },
      { id: 'oracle', label: 'ORACLE', icon: '🔮', steps: ['synthesis', 'regime weights', 'conviction scoring'], agents: ['oracle'] },
      { id: 'portfolio', label: 'PORTFOLIO', icon: '💰', steps: ['risk checks', 'execute', 'log lesson'], agents: ['portfolio_manager'] },
    ],
    deep: [
      { id: 'regime', label: 'REGIME', icon: '🌐', steps: ['market regime', 'macro context'], agents: ['regime_detector'] },
      { id: 'scout', label: 'SCOUT', icon: '🔍', steps: ['heuristic scan', 'LLM ranking', 'deep filter'], agents: ['scout'] },
      { id: 'pre_mortem', label: 'PRE-MORTEM', icon: '💭', steps: ['scenario analysis', 'veto check', 'risk assessment'], agents: ['risk_analyst'] },
      { id: 'war_room', label: 'WAR ROOM', icon: '🎯', steps: ['macro context', 'sentiment brief', 'sector analysis'], agents: ['macro', 'sentiment'] },
      { id: 'agents', label: 'AGENTS', icon: '👥', steps: ['technical', 'fundamental', 'sentiment', 'news', 'risk', 'growth', 'value', 'momentum', 'contrarian', 'macro', 'activist', 'valuation'], agents: ['Warren', 'Charlie', 'Technical', 'Fundamental', 'Sentiment', 'Risk', 'Momentum', 'Value', 'Growth', 'Contrarian', 'Activist', 'Valuation'] },
      { id: 'inquisition', label: 'INQUISITION', icon: '⚖️', steps: ['vote counting', 'consensus check', 'dissenter ID'], agents: [] },
      { id: 'oracle', label: 'ORACLE', icon: '🔮', steps: ['synthesis', 'regime weights', 'conviction scoring', 'kelly sizing'], agents: ['oracle'] },
      { id: 'portfolio', label: 'PORTFOLIO', icon: '💰', steps: ['risk checks', 'execute', 'log lesson', 'cleanup'], agents: ['portfolio_manager'] },
    ],
  },
  
  // TRADINGAGENTS PIPELINE
  tradingagents: {
    quick: [
      { id: 'regime', label: 'REGIME', icon: '🌐', steps: ['market regime'], agents: ['regime_detector'] },
      { id: 'scout', label: 'SCOUT', icon: '🔍', steps: ['screeners', 'news pull'], agents: ['scout'] },
      { id: 'analysts', label: 'ANALYSTS', icon: '📊', steps: ['technical', 'news'], agents: ['market_analyst', 'news_analyst'] },
      { id: 'trader', label: 'TRADER', icon: '🧠', steps: ['proposal'], agents: ['trader'] },
      { id: 'portfolio_manager', label: 'PM', icon: '🔮', steps: ['approve / reject'], agents: ['portfolio_manager'] },
      { id: 'execution', label: 'VAULT', icon: '💰', steps: ['buy / hold / sell'], agents: ['executor'] },
    ],
    standard: [
      { id: 'regime', label: 'REGIME', icon: '🌐', steps: ['market regime'], agents: ['regime_detector'] },
      { id: 'scout', label: 'SCOUT', icon: '🔍', steps: ['screeners', 'news pull', 'candidate filter'], agents: ['scout'] },
      { id: 'analysts', label: 'ANALYSTS', icon: '📊', steps: ['fundamental', 'sentiment', 'news', 'technical'], agents: ['market_analyst', 'social_analyst', 'news_analyst', 'fundamentals_analyst'] },
      { id: 'researchers', label: 'DEBATE', icon: '⚖️', steps: ['bull case', 'bear case'], agents: ['bull_researcher', 'bear_researcher', 'research_judge'] },
      { id: 'trader', label: 'TRADER', icon: '🧠', steps: ['investment plan'], agents: ['trader'] },
      { id: 'risk', label: 'RISK', icon: '💀', steps: ['risk review'], agents: ['aggressive_analyst', 'conservative_analyst', 'neutral_analyst', 'risk_judge'] },
      { id: 'portfolio_manager', label: 'PM', icon: '🔮', steps: ['final decision'], agents: ['portfolio_manager'] },
      { id: 'execution', label: 'VAULT', icon: '💰', steps: ['broker action'], agents: ['executor'] },
    ],
    deep: [
      { id: 'regime', label: 'REGIME', icon: '🌐', steps: ['market regime', 'macro context'], agents: ['regime_detector'] },
      { id: 'scout', label: 'SCOUT', icon: '🔍', steps: ['screeners', 'news pull', 'candidate filter', 'ranking'], agents: ['scout'] },
      { id: 'analysts', label: 'ANALYSTS', icon: '📊', steps: ['fundamental', 'sentiment', 'news', 'technical'], agents: ['market_analyst', 'social_analyst', 'news_analyst', 'fundamentals_analyst'] },
      { id: 'researchers', label: 'DEBATE', icon: '⚖️', steps: ['bull round 1', 'bear round 1', 'bull round 2', 'bear round 2'], agents: ['bull_researcher', 'bear_researcher', 'research_judge'] },
      { id: 'trader', label: 'TRADER', icon: '🧠', steps: ['proposal', 'refinement'], agents: ['trader'] },
      { id: 'risk', label: 'RISK', icon: '💀', steps: ['risk debate', 'position review'], agents: ['aggressive_analyst', 'conservative_analyst', 'neutral_analyst', 'risk_judge'] },
      { id: 'portfolio_manager', label: 'PM', icon: '🔮', steps: ['approval', 'allocation'], agents: ['portfolio_manager'] },
      { id: 'execution', label: 'VAULT', icon: '💰', steps: ['submit', 'confirm'], agents: ['executor'] },
    ],
  },
};

function getVisiblePhases(pipelineMode, researchDepth) {
  // MANDATORY: Backend drives everything
  // Frontend NEVER guesses - just renders
  
  if (!pipelineMode || !PIPELINE_CONFIG[pipelineMode]) {
    pipelineMode = 'original';
  }
  
  if (!researchDepth || !PIPELINE_CONFIG[pipelineMode][researchDepth]) {
    researchDepth = 'standard';
  }
  
  return PIPELINE_CONFIG[pipelineMode][researchDepth];
}

function getStationForAgent(agentId) {
  const stationMap = {
    regime_detector: 'scanner', scout: 'scanner',
    market_analyst: 'scanner', social_analyst: 'scanner', news_analyst: 'scanner', fundamentals_analyst: 'scanner',
    Technical: 'scanner', Momentum: 'scanner',
    Warren: 'desk', Charlie: 'desk', Fundamental: 'desk', Value: 'desk', Growth: 'desk',
    bull_researcher: 'desk', bear_researcher: 'desk', research_judge: 'desk', trader: 'desk',
    macro: 'tv', sentiment: 'tv', Risk: 'tv',
    aggressive_analyst: 'tv', conservative_analyst: 'tv', neutral_analyst: 'tv', risk_judge: 'tv',
    Contrarian: 'cooler',
    oracle: 'table', portfolio_manager: 'desk',
    executor: 'vault',
  };
  return stationMap[agentId] || 'desk';
}

// =============================================================================
// METRO FLOW COMPONENT
// =============================================================================

export const MetroFlow = ({
  pipelineMode = 'original',
  researchDepth = 'standard',
  pipelinePhase = 'idle',
  currentStep = '',
  cycle = 0,
  ticker = '',
  decision = '',
  phaseAgents = {},
}) => {
  // Derive visible phases from backend config
  const visiblePhases = useMemo(() => {
    return getVisiblePhases(pipelineMode, researchDepth);
  }, [pipelineMode, researchDepth]);

  // Find active phase index
  const currentPhaseIndex = useMemo(() => {
    return visiblePhases.findIndex(p => p.id === pipelinePhase);
  }, [visiblePhases, pipelinePhase]);

  // Get active phase object
  const activePhase = currentPhaseIndex >= 0 ? visiblePhases[currentPhaseIndex] : null;

  // Find active step index within active phase
  const currentStepIndex = useMemo(() => {
    if (!activePhase) return -1;
    return activePhase.steps.findIndex(step => step === currentStep);
  }, [activePhase, currentStep]);

  // Calculate progress percentage
  const progressPercentage = useMemo(() => {
    if (currentPhaseIndex < 0) return 0;
    if (visiblePhases.length <= 1) return 0;
    return (currentPhaseIndex / (visiblePhases.length - 1)) * 100;
  }, [currentPhaseIndex, visiblePhases.length]);

  return (
    <div className="metro-flow-container">
      {/* Header */}
      <div className="metro-flow-header">
        <span className="metro-cycle">CYCLE #{String(cycle).padStart(2, '0')}</span>
        <span className="metro-ticker">{ticker || 'IDLE'}</span>
        <span className="metro-mode">
          {pipelineMode.toUpperCase()} {pipelineMode === 'tradingagents' && `(${researchDepth.toUpperCase()})`}
        </span>
        {decision && (
          <span className={`metro-decision metro-decision--${decision.toLowerCase()}`}>
            {decision}
          </span>
        )}
      </div>

      {/* Track with progress line */}
      <div className="metro-flow-track-wrapper">
        <div className="metro-flow-track-line">
          <div
            className="metro-flow-track-progress"
            style={{ width: `${progressPercentage}%` }}
          />
        </div>

        {/* Phase stations */}
        <div className="metro-flow-stations">
          {visiblePhases.map((phase, idx) => {
            const isActive = phase.id === pipelinePhase;
            const isDone = currentPhaseIndex > idx;

            return (
              <div
                key={phase.id}
                className={`metro-station ${isActive ? 'metro-station--active' : ''} ${isDone ? 'metro-station--done' : ''}`}
              >
                {/* Station icon and label */}
                <div className="metro-station__icon">{phase.icon}</div>
                <div className="metro-station__label">{phase.label}</div>

                {/* Substeps - ONLY shown for active phase */}
                {isActive && phase.steps?.length > 0 && (
                  <div className="metro-substeps">
                    {phase.steps.map((step, stepIdx) => {
                      const isStepActive = step === currentStep;
                      const isStepDone = currentStepIndex > stepIdx;

                      return (
                        <div
                          key={step}
                          className={`metro-substep ${isStepActive ? 'metro-substep--active' : ''} ${isStepDone ? 'metro-substep--done' : ''}`}
                        >
                          <span className="metro-substep__dot" />
                          <span className="metro-substep__label">{step}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// =============================================================================
// METRO FLOW WITH AGENT DETAILS
// =============================================================================

export const MetroFlowWithAgents = ({
  pipelineMode = 'original',
  researchDepth = 'standard',
  pipelinePhase = 'idle',
  currentStep = '',
  cycle = 0,
  ticker = '',
  decision = '',
  agentStates = {},  // { agent_id: { status, action, confidence } }
}) => {
  // Get active phase
  const activePhase = useMemo(() => {
    const phases = getVisiblePhases(pipelineMode, researchDepth);
    return phases.find(p => p.id === pipelinePhase) || null;
  }, [pipelineMode, researchDepth, pipelinePhase]);

  // Get agents for active phase
  const activeAgents = activePhase?.agents || [];

  return (
    <div className="metro-flow-with-agents">
      {/* Base MetroFlow */}
      <MetroFlow
        pipelineMode={pipelineMode}
        researchDepth={researchDepth}
        pipelinePhase={pipelinePhase}
        currentStep={currentStep}
        cycle={cycle}
        ticker={ticker}
        decision={decision}
      />

      {/* Agent details for active phase */}
      {activeAgents.length > 0 && (
        <div className="metro-agents-panel">
          <h3 className="metro-agents-title">
            {activePhase.icon} {activePhase.label} Agents
          </h3>
          <div className="metro-agents-grid">
            {activeAgents.map(agentId => {
              const agentState = agentStates[agentId] || {};
              const station = get_station_for_agent(agentId);

              return (
                <div
                  key={agentId}
                  className={`metro-agent-card metro-agent-card--${agentState.status || 'idle'}`}
                >
                  <div className="metro-agent-card__station">{getStationForAgent(agentId)}</div>
                  <div className="metro-agent-card__name">{agentId}</div>
                  {agentState.action && (
                    <div className={`metro-agent-card__action metro-action--${agentState.action?.toLowerCase()}`}>
                      {agentState.action}
                    </div>
                  )}
                  {agentState.confidence && (
                    <div className="metro-agent-card__confidence">
                      {Math.round(agentState.confidence * 100)}%
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// =============================================================================
// EVENT LISTENER HOOK
// =============================================================================

export const usePipelineEvents = (websocket, onEvent) => {
  React.useEffect(() => {
    if (!websocket) return;

    const handleMessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Map backend event to MetroFlow props
        const props = {
          pipelineMode: data.pipeline_mode || 'original',
          researchDepth: data.research_depth || 'standard',
          pipelinePhase: data.phase || data.sub_phase || 'idle',
          currentStep: data.current_step || '',
          cycle: data.cycle || 0,
          ticker: data.ticker || '',
          decision: data.decision || '',
        };

        if (onEvent) {
          onEvent(props, data);
        }
      } catch (err) {
        console.error('Failed to parse pipeline event:', err);
      }
    };

    websocket.addEventListener('message', handleMessage);
    return () => websocket.removeEventListener('message', handleMessage);
  }, [websocket, onEvent]);
};

// =============================================================================
// EXAMPLE USAGE
// =============================================================================

/**
 * Example: How to use in your app
 * 
 * import { MetroFlow, usePipelineEvents } from './MetroFlow';
 * 
 * const TradingDashboard = () => {
 *   const [props, setProps] = useState({
 *     pipelineMode: 'tradingagents',
 *     researchDepth: 'standard',
 *     pipelinePhase: 'idle',
 *     currentStep: '',
 *     cycle: 0,
 *     ticker: '',
 *     decision: '',
 *   });
 * 
 *   // Connect to WebSocket
 *   usePipelineEvents(
 *     ws.current,
 *     (props, rawEvent) => {
 *       setProps(props);
 *     }
 *   );
 * 
 *   return (
 *     <div>
 *       <MetroFlow {...props} />
 *     </div>
 *   );
 * };
 */
