import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  compactRunText as compactText,
  getDecisionSummary,
  getFullPrediction,
  isLegacyTradingAgentsRun,
  sortRunsNewestFirst,
  standardizeAction,
} from '../../utils/tradingAgentRuns'
import { broadcastSceneCommand } from '../trading-floor/canvas/Showrunner'

const API_BASE = ''
const RUNS_API_BASE = '/api/admin/trading-agents/runs'

const readJsonSafely = async (response) => {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const playScenePackage = (scene) => {
  if (!scene) return
  const dialogueSource = Array.isArray(scene.lines) && scene.lines.length > 0
    ? scene.lines
    : (Array.isArray(scene.script?.dialogue) ? scene.script.dialogue : [])
  broadcastSceneCommand({
    type: 'PLAY_STEP_SCENE',
    phase: scene.phase,
    ticker: scene.ticker,
    headline: scene.headline,
    state: scene.state,
    agents: scene.active_agents || [],
    dialogue: dialogueSource.map((line) => ({
      agent: line.speaker || line.agent,
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
    trigger: 'runs-panel',
  })
}

const getSceneEntryKey = (entry, fallbackIndex = 0) => {
  if (!entry) return `scene-${fallbackIndex}`
  if (entry.scene_id) return String(entry.scene_id)
  const attempt = Number(entry.attempt || 1)
  const sceneIndex = Number.isFinite(Number(entry.scene_index))
    ? Number(entry.scene_index)
    : fallbackIndex
  return `${attempt}:${sceneIndex}`
}

const CANONICAL_TIMELINE_SLOTS = [
  { index: 0, label: '00 INIT' },
  { index: 1, label: '01 Market Report' },
  { index: 2, label: '02 Sentiment Report' },
  { index: 3, label: '03 News Report' },
  { index: 4, label: '04 Fundamentals Report' },
  { index: 5, label: '05 Bull Researcher Report' },
  { index: 6, label: '06 Bear Researcher Report' },
  { index: 7, label: '07 Research Manager Report' },
  { index: 8, label: '08 Trader Plan Report' },
  { index: 9, label: '09 Aggressive Analyst Report' },
  { index: 10, label: '10 Conservative Analyst Report' },
  { index: 11, label: '11 Neutral Analyst Report' },
  { index: 12, label: '12 Portfolio Decision Report' },
]

const sceneDialogueLines = (scene) => {
  if (Array.isArray(scene?.script?.dialogue) && scene.script.dialogue.length > 0) {
    return scene.script.dialogue.map((line, idx) => ({
      order: line?.order || idx + 1,
      speaker: line?.speaker || line?.agent || 'Unknown',
      text: line?.text || '',
      role: line?.role || null,
    }))
  }
  if (Array.isArray(scene?.lines)) {
    return scene.lines.map((line, idx) => ({
      order: idx + 1,
      speaker: line?.speaker || line?.agent || 'Unknown',
      text: line?.text || '',
      role: null,
    }))
  }
  return []
}

export function RunsPanel() {
  const [recentRuns, setRecentRuns] = useState([])
  const [runtimeInfo, setRuntimeInfo] = useState(null)
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [selectedRunDetails, setSelectedRunDetails] = useState(null)
  const [, _setIsFetchingDetails] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [inspectRunData, setInspectRunData] = useState(null)
  const [inspectSceneKey, setInspectSceneKey] = useState(null)
  const [showInspectorJson, setShowInspectorJson] = useState(false)
  const [isFullReportOpen, setIsFullReportOpen] = useState(false)
  const [selectedSceneKey, setSelectedSceneKey] = useState(null)

  const selectedSceneHistory = useMemo(() => {
    const raw = Array.isArray(selectedRunDetails?.scene_history) ? selectedRunDetails.scene_history : []
    return [...raw].sort((a, b) => {
      const leftIndex = Number.isFinite(Number(a?.scene_index)) ? Number(a.scene_index) : 999
      const rightIndex = Number.isFinite(Number(b?.scene_index)) ? Number(b.scene_index) : 999
      if (leftIndex !== rightIndex) return leftIndex - rightIndex
      return String(a?.created_at || '').localeCompare(String(b?.created_at || ''))
    })
  }, [selectedRunDetails])

  const selectedSceneEntry = useMemo(() => {
    if (selectedSceneHistory.length === 0) return null
    if (selectedSceneKey) {
      const matched = selectedSceneHistory.find(
        (entry, index) => getSceneEntryKey(entry, index) === selectedSceneKey,
      )
      if (matched) return matched
    }
    return selectedSceneHistory[selectedSceneHistory.length - 1]
  }, [selectedSceneHistory, selectedSceneKey])

  const inspectorSceneHistory = useMemo(() => {
    const raw = Array.isArray(inspectRunData?.scene_history) ? inspectRunData.scene_history : []
    return [...raw].sort((a, b) => {
      const leftIndex = Number.isFinite(Number(a?.scene_index)) ? Number(a.scene_index) : 999
      const rightIndex = Number.isFinite(Number(b?.scene_index)) ? Number(b.scene_index) : 999
      if (leftIndex !== rightIndex) return leftIndex - rightIndex
      return String(a?.created_at || '').localeCompare(String(b?.created_at || ''))
    })
  }, [inspectRunData])

  const inspectorTimeline = useMemo(() => {
    const byIndex = new Map()
    inspectorSceneHistory.forEach((entry, idx) => {
      const sceneIndex = Number.isFinite(Number(entry?.scene_index))
        ? Number(entry.scene_index)
        : idx
      if (!byIndex.has(sceneIndex)) {
        byIndex.set(sceneIndex, entry)
      }
    })
    return CANONICAL_TIMELINE_SLOTS.map((slot) => ({
      ...slot,
      entry: byIndex.get(slot.index) || null,
    }))
  }, [inspectorSceneHistory])

  const inspectorSelectedTimelineItem = useMemo(() => {
    if (inspectorTimeline.length === 0) return null
    if (inspectSceneKey) {
      const matched = inspectorTimeline.find((item) => String(item.index) === String(inspectSceneKey))
      if (matched) return matched
    }
    const latestGenerated = [...inspectorTimeline].reverse().find((item) => item.entry)
    return latestGenerated || inspectorTimeline[0]
  }, [inspectSceneKey, inspectorTimeline])

  const inspectorSelectedScene = inspectorSelectedTimelineItem?.entry?.scene || null
  const inspectorDialogue = sceneDialogueLines(inspectorSelectedScene)
  const inspectorAnimations = Array.isArray(inspectorSelectedScene?.animations) ? inspectorSelectedScene.animations : []
  const inspectorStations = Array.isArray(inspectorSelectedScene?.station_targets) ? inspectorSelectedScene.station_targets : []
  const inspectorPaths = inspectorSelectedScene?.agent_paths || {}
  const inspectorMovement = Array.isArray(inspectorSelectedScene?.movement_plan) ? inspectorSelectedScene.movement_plan : []

  const refreshRunDetails = useCallback(async (runId) => {
    if (!runId) return null
    _setIsFetchingDetails(true)
    try {
      const response = await fetch(`${API_BASE}${RUNS_API_BASE}/${runId}`, { cache: 'no-store' })
      const data = await readJsonSafely(response)
      if (response.ok && data) {
        setSelectedRunDetails(data)
        return data
      }
    } catch (error) {
      console.error('Failed to fetch run details:', error)
    } finally {
      _setIsFetchingDetails(false)
    }
    return null
  }, [])

  const openRunInspector = useCallback(async (run, defaultSceneIndex = null) => {
    if (!run?.run_id) return
    setSelectedRunId(run.run_id)
    setShowInspectorJson(false)
    const detailed = await refreshRunDetails(run.run_id)
    const payload = detailed || (selectedRunDetails?.run_id === run.run_id ? selectedRunDetails : run)
    const history = Array.isArray(payload?.scene_history) ? payload.scene_history : []
    setInspectRunData({
      ...payload,
      scene_history: history,
    })
    const latestGenerated = [...history].reverse().find((entry) => Number.isFinite(Number(entry?.scene_index)))
    const fallbackIndex = latestGenerated ? Number(latestGenerated.scene_index) : 0
    setInspectSceneKey(String(defaultSceneIndex != null ? defaultSceneIndex : fallbackIndex))
  }, [refreshRunDetails, selectedRunDetails])

  const fetchRecentRuns = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await fetch(`${API_BASE}${RUNS_API_BASE}?limit=30`, { cache: 'no-store' })
      const data = await readJsonSafely(response)
      if (response.ok && data) {
        const rawRuns = Array.isArray(data.runs) ? data.runs : []
        const sortedRuns = sortRunsNewestFirst(rawRuns)
        const modernRuns = sortedRuns.filter((run) => !isLegacyTradingAgentsRun(run))
        const visibleRuns = modernRuns.length > 0 ? modernRuns : sortedRuns
        setRecentRuns(visibleRuns)
        setRuntimeInfo(data.runtime || null)
        setSelectedRunId((prev) => {
          if (prev && visibleRuns.some((run) => run.run_id === prev)) return prev
          return visibleRuns[0]?.run_id || null
        })
      }
    } catch (error) {
      console.error(error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRecentRuns()
    const dataInt = setInterval(fetchRecentRuns, 5000)
    return () => clearInterval(dataInt)
  }, [fetchRecentRuns])

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetails(null)
      setSelectedSceneKey(null)
      return
    }
    refreshRunDetails(selectedRunId)
  }, [refreshRunDetails, selectedRunId])

  useEffect(() => {
    if (!selectedRunDetails?.run_id) {
      setSelectedSceneKey(null)
      return
    }
    const history = Array.isArray(selectedRunDetails.scene_history) ? selectedRunDetails.scene_history : []
    if (history.length === 0) {
      setSelectedSceneKey(null)
      return
    }
    setSelectedSceneKey((prev) => {
      if (prev && history.some((entry, index) => getSceneEntryKey(entry, index) === prev)) {
        return prev
      }
      return getSceneEntryKey(history[history.length - 1], history.length - 1)
    })
  }, [selectedRunDetails])

  return (
    <div className="tab-content final-reports-panel runs-tab-content h-full flex flex-col">
      <div className="flex-1 min-h-0">
        <div className="reports-command-deck reports-command-deck--history runs-command-deck">
          <div className="reports-command-body">
            <aside className="reports-command-timeline" aria-label="History runs list">
              <header className="reports-command-section-title">
                <span>HISTORY RUNS</span>
                <span>{isLoading ? 'LOADING' : `${recentRuns.length} ROWS`}</span>
              </header>
              <div className="runs-panel-scroll">
                <section className="premium-tactical-hud runs-command-list flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between p-0.5 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-1">
            <h2 className="text-[14px] font-bold tracking-widest text-accent uppercase">History Runs</h2>
            <div className="text-[13px] font-medium text-muted/50 data-mono">— REAL-TIME OBSERVABILITY</div>
          </div>
          <div className="text-[12px] text-muted/70 data-mono whitespace-nowrap">
            MODE {String(runtimeInfo?.scene_dialogue_mode || '--').toUpperCase()} | BUILD {runtimeInfo?.build_hash || '--'}
          </div>
        </header>

        <div className="flex-1 overflow-x-auto overflow-y-auto scrollbar-tactical">
          <table className="w-full text-left border-collapse min-w-[560px]">
            <thead className="sticky top-0 z-20 bg-black">
              <tr className="border-b border-white/5 bg-white/[0.02]">
                  <th className="p-2 text-[13px] font-bold text-muted uppercase tracking-widest">Ticker</th>
                  <th className="p-2 text-[13px] font-bold text-muted uppercase tracking-widest text-center">Call</th>
                  <th className="p-2 text-[13px] font-bold text-muted uppercase tracking-widest text-center">Depth</th>
                  <th className="p-2 text-[13px] font-bold text-muted uppercase tracking-widest text-right">Action</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {!isLoading && recentRuns.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-[12px] text-muted italic">NO RECENT PIPELINE RUNS</td>
                </tr>
              )}
              {recentRuns.map((run, idx) => {
                  const isSelected = selectedRunId === run.run_id
                  const summary = getDecisionSummary(run)
                  const fullPrediction = getFullPrediction(run)

                  return (
                    <Fragment key={run.run_id}>
                      <motion.tr
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.02 }}
                        onClick={() => setSelectedRunId(isSelected ? null : run.run_id)}
                        className={`group transition-colors cursor-pointer ${isSelected ? 'bg-highlight/5' : 'hover:bg-white/[0.02]'}`}
                      >
                        <td className="p-2 text-[14px] font-bold text-highlight">{run.ticker}</td>
                        <td className="p-2 text-center">
                          <span className={`px-2 py-1 rounded-[1px] text-[13px] font-bold ${
                            (run.recommended_action || run.model_action) === 'BUY' ? 'bg-accent/10 text-accent border border-accent/20' :
                            (run.recommended_action || run.model_action) === 'SELL' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                            'bg-white/5 text-muted border border-white/10'
                          }`}>
                            {standardizeAction(run.recommended_action || run.model_action)}
                          </span>
                        </td>
                        <td className="p-2 text-center text-[13px] data-mono">
                          <span className={`px-2 py-1 rounded-[1px] text-[12px] font-bold border ${
                            run.research_depth === 'deep' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' :
                            run.research_depth === 'standard' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                            'bg-white/5 text-muted border border-white/10'
                          }`}>
                            {(run.research_depth || 'quick').toUpperCase()}
                          </span>
                        </td>
                        <td className="p-2 text-right">
                          <div className="flex gap-0.5 justify-end flex-wrap">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedRunId(isSelected ? null : run.run_id)
                              }}
                              className="text-[13px] font-bold text-accent hover:underline tracking-tighter uppercase"
                            >
                              {isSelected ? 'HIDE' : 'VIEW'}
                            </button>
                          </div>
                        </td>
                      </motion.tr>
                      <AnimatePresence>
                        {isSelected && (
                          <motion.tr
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                          >
                            <td colSpan={4} className="p-0 border-none bg-black/40">
                              <div className="p-2 border-y border-white/10 shadow-inner relative overflow-hidden">
                                <div className="space-y-0.5 relative z-10">
                                  <div className="flex items-center gap-0.5">
                                    <h3 className="text-[16px] font-bold tracking-tight text-white">{run.ticker} <span className="text-muted font-normal">/</span> {standardizeAction(run.recommended_action)}</h3>
                                    <div className="h-px flex-1 bg-white/10" />
                                  </div>
                                  <p className="text-[15px] text-white/85 leading-7 max-w-4xl">{summary}</p>
                                  {fullPrediction && compactText(fullPrediction, 500) !== summary && (
                                    <div className="bg-black/30 border border-white/10 p-0.5 space-y-0.5">
                                      <div className="text-[13px] font-bold text-muted uppercase tracking-widest">Report Excerpt</div>
                                      <div className="text-[13px] text-white/80 leading-6 whitespace-pre-wrap">
                                        {compactText(fullPrediction, 1100)}
                                      </div>
                                    </div>
                                  )}

                                  <div className="flex gap-0.5 pt-2">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedRunId(run.run_id)
                                        setIsFullReportOpen(true)
                                      }}
                                      className="tactical-trigger text-[13px] border-accent/40 text-accent hover:bg-accent/10"
                                    >
                                      VIEW FULL ANALYSIS
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </motion.tr>
                        )}
                      </AnimatePresence>
                    </Fragment>
                  )
                })}
            </tbody>
          </table>
        </div>
                </section>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {inspectRunData && (
        <div className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-[#111] border border-blue-500/30 p-4 max-w-6xl w-full max-h-[88vh] overflow-y-auto font-mono text-[10px] relative shadow-[0_0_20px_rgba(0,100,255,0.1)]">
            <div className="flex justify-between items-center mb-4 border-b border-white/10 pb-2 sticky top-0 bg-[#111] z-10">
              <div>
                <h2 className="text-blue-400 text-sm font-bold tracking-widest">SCENE PAYLOAD INSPECTOR</h2>
                <div className="text-[9px] text-blue-100/70 mt-1">
                  {inspectRunData?.ticker || '--'} | {inspectRunData?.run_status || '--'} | SCENES {inspectorSceneHistory.length}/13
                </div>
              </div>
              <button
                onClick={() => {
                  setInspectRunData(null)
                  setInspectSceneKey(null)
                  setShowInspectorJson(false)
                }}
                className="text-red-500 hover:text-red-400 hover:bg-red-950/40 px-3 py-1 border border-red-500/50 transition-colors"
              >
                CLOSE [X]
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 text-white/80">
              {String(inspectRunData?.run_status || '').toUpperCase() === 'RUNNING' && inspectorSceneHistory.length === 0 && (
                <div className="lg:col-span-12 bg-red-950/30 border border-red-500/40 rounded p-3 text-red-200 text-[10px]">
                  Canonical scene stream is missing for this active run. Pathfinding/animation/dialogue payloads have not been generated yet.
                </div>
              )}
              <div className="lg:col-span-4 bg-black/50 border border-white/10 rounded p-2">
                <h3 className="text-[11px] text-blue-300 font-bold mb-2 border-l-2 border-blue-500 pl-2">TIMELINE (00-12)</h3>
                <div className="space-y-1 max-h-[65vh] overflow-y-auto">
                  {inspectorTimeline.map((item) => {
                    const isSelected = String(item.index) === String(inspectSceneKey)
                    const generated = Boolean(item.entry?.scene)
                    return (
                      <button
                        key={`inspect-slot-${item.index}`}
                        type="button"
                        onClick={() => setInspectSceneKey(String(item.index))}
                        className={`w-full text-left px-2 py-1 border rounded ${isSelected ? 'border-accent/70 bg-accent/10 text-accent' : 'border-white/10 text-white/80 hover:border-accent/40'}`}
                      >
                        <div className="flex justify-between items-center gap-2">
                          <span className="font-bold">{item.entry?.scene_label || item.label}</span>
                          <span className={`text-[8px] px-1 py-0.5 border rounded ${generated ? 'border-green-400/40 text-green-300' : 'border-white/20 text-white/50'}`}>
                            {generated ? 'GENERATED' : 'NOT GENERATED YET'}
                          </span>
                        </div>
                        {generated && (
                          <div className="text-[8px] text-white/60 mt-0.5">
                            ATTEMPT {item.entry?.attempt || '--'} | {item.entry?.scene_kind || '--'}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="lg:col-span-8 space-y-3">
                {!inspectorSelectedScene ? (
                  <div className="bg-black/50 border border-white/10 rounded p-3 text-white/70">
                    No scene payload available for this slot.
                  </div>
                ) : (
                  <>
                    <div className="bg-black/50 border border-white/10 rounded p-3">
                      <h3 className="text-[11px] text-blue-300 font-bold mb-2 border-l-2 border-blue-500 pl-2">
                        DIALOGUE SEQUENCE ({inspectorDialogue.length} Lines)
                      </h3>
                      <div className="space-y-1">
                        {inspectorDialogue.map((line, i) => (
                          <div key={`dialogue-${i}`} className="flex gap-2">
                            <span className="text-muted min-w-[20px] text-right">#{line.order || i + 1}</span>
                            <span className="text-blue-200 font-bold min-w-[140px]">{line.speaker}:</span>
                            <span className="text-white/90">{line.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-black/50 border border-white/10 rounded p-3">
                      <h3 className="text-[11px] text-cyan-300 font-bold mb-2 border-l-2 border-cyan-500 pl-2">SCENE METADATA</h3>
                      <div className="flex flex-wrap gap-2 text-[9px] text-cyan-100/80">
                        <span>Label: {inspectorSelectedTimelineItem?.entry?.scene_label || inspectorSelectedTimelineItem?.label || '--'}</span>
                        <span>Attempt: {inspectorSelectedTimelineItem?.entry?.attempt || '--'}</span>
                        <span>Kind: {inspectorSelectedTimelineItem?.entry?.scene_kind || '--'}</span>
                        <span>Source Slot: {inspectorSelectedTimelineItem?.entry?.source_report_slot ?? '--'}</span>
                        <span>Drama: {String(inspectorSelectedScene?.script?.drama_level || inspectorSelectedScene?.script_meta?.drama_level || '--').toUpperCase()}</span>
                        <span>Writer: {inspectorSelectedScene?.script?.writer_source || inspectorSelectedScene?.script_meta?.writer_source || '--'}</span>
                        <span>Model: {inspectorSelectedScene?.script?.writer_model || inspectorSelectedScene?.script_meta?.writer_model || '--'}</span>
                        <span>Latency: {inspectorSelectedScene?.script?.writer_latency_ms ?? inspectorSelectedScene?.script_meta?.writer_latency_ms ?? '--'}ms</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="bg-black/50 border border-white/10 rounded p-3">
                        <h3 className="text-[11px] text-green-300 font-bold mb-2 border-l-2 border-green-500 pl-2">ANIMATIONS</h3>
                        <div className="space-y-1 max-h-[220px] overflow-y-auto">
                          {inspectorAnimations.map((anim, i) => (
                            <div key={`anim-${i}`} className="flex justify-between border-b border-white/5 pb-1">
                              <span className="text-white/80">{anim.agent}</span>
                              <span className="text-green-200 font-bold">{anim.animation}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="bg-black/50 border border-white/10 rounded p-3">
                        <h3 className="text-[11px] text-purple-300 font-bold mb-2 border-l-2 border-purple-500 pl-2">STATIONS + PATHS</h3>
                        <div className="space-y-1 max-h-[220px] overflow-y-auto">
                          {inspectorStations.map((stationRow, i) => (
                            <div key={`station-path-${i}`} className="flex justify-between border-b border-white/5 pb-1 gap-2">
                              <span className="text-white/80">{stationRow.agent}</span>
                              <span className="text-purple-200">{stationRow.station}</span>
                              <span className="text-yellow-200 font-bold">{inspectorPaths?.[stationRow.agent] || 'direct'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="bg-black/50 border border-white/10 rounded p-3">
                      <h3 className="text-[11px] text-orange-300 font-bold mb-2 border-l-2 border-orange-500 pl-2">
                        MOVEMENT PLAN ({inspectorMovement.length})
                      </h3>
                      <div className="space-y-1 max-h-[180px] overflow-y-auto">
                        {inspectorMovement.map((move, i) => (
                          <div key={`move-${i}`} className="flex justify-between border-b border-white/5 pb-1 gap-2">
                            <span className="text-white/80">{move.agent}</span>
                            <span className="text-white/60">{move.from} {'->'} {move.to}</span>
                            <span className="text-orange-200 font-bold">{move.mode}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-black/50 border border-white/10 rounded p-3">
                      <button
                        type="button"
                        onClick={() => setShowInspectorJson((prev) => !prev)}
                        className="text-[10px] text-yellow-300 border border-yellow-500/40 px-2 py-1 rounded hover:bg-yellow-900/20"
                      >
                        {showInspectorJson ? 'HIDE DEVELOPER JSON' : 'SHOW DEVELOPER JSON'}
                      </button>
                      {showInspectorJson && (
                        <pre className="bg-black/80 p-3 border border-white/5 whitespace-pre-wrap rounded text-[9px] text-yellow-100/70 font-mono mt-2">
                          {JSON.stringify(inspectorSelectedScene, null, 2)}
                        </pre>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {isFullReportOpen && selectedRunDetails && (
        <div className="fixed inset-0 z-[10000] bg-black/95 flex items-center justify-center p-6 backdrop-blur-md">
          <div className="bg-[#0a0a0a] border border-accent/30 w-full max-w-6xl h-[90vh] flex flex-col shadow-[0_0_50px_rgba(30,144,255,0.15)] overflow-hidden">
            <header className="flex items-center justify-between p-4 border-b border-white/10 bg-white/[0.02]">
              <div className="flex flex-col">
                <h2 className="text-accent text-sm font-bold tracking-widest uppercase flex items-center gap-2">
                  <div className="w-2 h-2 bg-accent animate-pulse" />
                  Full Agent Analysis Report
                </h2>
                <div className="text-[10px] text-muted data-mono mt-1">
                  RUN ID: {selectedRunDetails.run_id} | TICKER: {selectedRunDetails.ticker} | DEPTH: {(selectedRunDetails.research_depth || 'standard').toUpperCase()}
                </div>
              </div>
              <button
                onClick={() => setIsFullReportOpen(false)}
                className="text-red-500 hover:bg-red-950/30 px-4 py-2 border border-red-500/40 text-[10px] font-bold tracking-widest transition-all"
              >
                CLOSE REPORT [ESC]
              </button>
            </header>

            <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-tactical">
              {(selectedRunDetails.agent_reports || []).map((report, idx) => (
                <div key={idx} className="border border-white/5 bg-white/[0.01] p-4 space-y-3 relative group">
                  <div className="absolute left-0 top-0 w-1 h-full bg-accent/20 group-hover:bg-accent transition-colors" />
                  <div className="flex justify-between items-center border-b border-white/5 pb-2">
                    <div className="flex items-center gap-3">
                      <span className="text-accent font-bold text-[11px] uppercase tracking-tighter">{report.agent || 'SYSTEM'}</span>
                      <span className="text-[9px] px-1.5 py-0.5 bg-white/5 text-muted border border-white/10 rounded-sm italic">{report.phase || report.role || 'Analysis'}</span>
                    </div>
                    <div className="text-[9px] data-mono text-muted/60">PHASE SECTION #{idx + 1}</div>
                  </div>
                  <div className="text-[11px] text-white/90 leading-relaxed whitespace-pre-wrap font-sans selection:bg-accent/30">
                    {report.report || report.text || report.summary || 'No report content available.'}
                  </div>
                </div>
              ))}

              {(selectedRunDetails.agent_reports || []).length === 0 && (
                <div className="h-full flex items-center justify-center text-muted italic text-[11px] flex-col gap-4 py-20">
                  <div className="w-12 h-12 border-2 border-white/5 border-t-accent rounded-full animate-spin" />
                  NO DETAILED AGENT REPORTS FOUND FOR THIS RUN
                </div>
              )}
            </div>

            <footer className="p-4 border-t border-white/10 bg-white/[0.01] flex justify-between items-center bg-black/40">
              <div className="text-[9px] text-muted uppercase tracking-[0.2em]">End of Multi-Phase Transmission</div>
              <div className="flex gap-2">
                <div className="px-2 py-1 bg-white/5 border border-white/10 text-[9px] text-muted data-mono">
                  COMPLETED: {new Date(selectedRunDetails.completed_at || selectedRunDetails.created_at).toLocaleString()}
                </div>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}

export default RunsPanel
