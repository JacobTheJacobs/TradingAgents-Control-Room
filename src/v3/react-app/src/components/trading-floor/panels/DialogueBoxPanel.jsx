import React, { useState, useEffect, useRef } from 'react';
// HMR Refresh: Color Refinement & Crisp Borders Applied
import PropTypes from 'prop-types';
import { motion } from 'framer-motion';
import { useTradingFloor } from '../../../context/TradingFloorContext';
import { TRADING_AGENT_DEFS, normalizeTradingAgentId, normalizeTradingAgentName, TRADING_AGENT_SCENE_MAP } from '../../../config/tradingAgentsRoster';
import { STEP_SCENES } from '../../../config/stepScenes';

export function DialogueBoxPanel({ currentTicker, sceneRef }) {
    const { state, setActiveScene } = useTradingFloor();
    const { activeDialogue, memeMode, activeScene, sceneControl, pipelineState } = state;
    const isTradingAgentsMode = String(pipelineState?.pipeline_mode || '').toLowerCase() === 'tradingagents';

    if (isTradingAgentsMode) {
        return null;
    }

    const shouldPersistCanonicalTimelineScene = Boolean(
        (isTradingAgentsMode && activeScene && (
            activeScene?.trigger === 'tradingagents-canonical'
            || activeScene?.variant === 'TradingAgents Timeline'
            || activeScene?.scriptMeta?.timeline_kind
        ))
    );
    const canonicalSceneIndex = Number(
        activeScene?.sceneIndex ??
        activeScene?.sourceReportSlot ??
        activeScene?.scriptMeta?.scene_index ??
        activeScene?.scriptMeta?.source_report_slot ??
        -1
    );
    const canonicalSceneKey = String(
        activeScene?.sceneKey ||
        activeScene?.scriptMeta?.scene_key ||
        ''
    ).trim();
    const shouldRetainCanonicalSceneLayout = Boolean(
        shouldPersistCanonicalTimelineScene &&
        (
            canonicalSceneIndex === 12 ||
            canonicalSceneKey === 'TA_TIMELINE_12_PORTFOLIO'
        )
    );

    const AGENT_IMAGE_MAP = React.useMemo(() => {
        const map = {
            System: { folder: 'scout', bases: ['scout'] },
            SYSTEM: { folder: 'scout', bases: ['scout'] },
        };

        TRADING_AGENT_DEFS.forEach((agent) => {
            map[agent.name] = agent.portrait;
            map[agent.id] = agent.portrait;
            map[agent.shortLabel] = agent.portrait;
            agent.aliases.forEach((alias) => {
                map[alias] = agent.portrait;
            });
        });

        return map;
    }, []);

    const [portraitManifest, setPortraitManifest] = useState({});
    const [portraitCacheBust] = useState(() => Date.now());

    useEffect(() => {
        let mounted = true;
        fetch('/assets/canvas/agents/manifest.json', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : {}))
            .then((data) => {
                if (mounted) setPortraitManifest(data || {});
            })
            .catch(() => { });
        return () => { mounted = false; };
    }, []);

    const hashString = (value) => {
        let hash = 0;
        if (!value) return hash;
        for (let i = 0; i < value.length; i += 1) {
            hash = ((hash << 5) - hash) + value.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    };

    const compactDialogueForBubble = (value) => {
        const source = String(value || '')
            .replace(/[*_#`>|~]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!source) return '';
        const hardLimit = 180;
        if (source.length <= hardLimit) return source;
        const clipped = source.slice(0, hardLimit).replace(/\s+\S*$/, '').trim();
        return `${clipped || source.slice(0, hardLimit).trim()}...`;
    };

    const getAgentImageSrc = (name) => {
        const canonicalName = normalizeTradingAgentName(name) || name;
        const key = (canonicalName || 'SYSTEM').trim();
        const entry = AGENT_IMAGE_MAP[key] || AGENT_IMAGE_MAP[key.replace(/ Agent$/, '')];
        const folder = entry?.folder;
        if (!folder) return null;
        const available = portraitManifest?.[folder] || [];
        if (!available.length) return null;
        const preferredBases = entry?.bases?.filter((base) => available.includes(base)) || [];
        if (!preferredBases.length) return null;

        let candidates = preferredBases;
        if (memeMode) {
            const memeCandidates = candidates.filter((base) => base.endsWith('_meme'));
            if (memeCandidates.length) {
                candidates = memeCandidates;
            }
        } else {
            const nonMeme = candidates.filter((base) => !base.endsWith('_meme'));
            if (nonMeme.length) {
                candidates = nonMeme;
            } else {
                return null;
            }
        }
        if (!candidates.length) return null;
        const selectedBase = candidates[0];
        return `/assets/canvas/agents/${folder}/${selectedBase}.png?v=${portraitCacheBust}`;
    };

    const [displayedText, setDisplayedText] = useState('');
    const [currentDialogueIndex, setCurrentDialogueIndex] = useState(0);
    const [isTyping, setIsTyping] = useState(false);
    const [dialogueComplete, setDialogueComplete] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const hasReturnedAgents = useRef(false);

    const [audioCtx] = useState(() => {
        try {
            return new (window.AudioContext || window.webkitAudioContext)();
        } catch {
            console.warn("AudioContext not supported");
            return null;
        }
    });

    const playBlip = () => {
        if (!audioCtx) return;
        try {
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => { });
            }
            if (audioCtx.state !== 'running') return;

            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();

            oscillator.type = 'square';
            oscillator.frequency.setValueAtTime(440, audioCtx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.05);

            gainNode.gain.setValueAtTime(0.01, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);

            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            oscillator.start();
            oscillator.stop(audioCtx.currentTime + 0.05);
        } catch { }
    };

    const sceneDialogue = activeScene?.dialogue || [];
    const currentDialogueLine = sceneDialogue[currentDialogueIndex];
    const currentStepId = normalizeTradingAgentId(pipelineState?.current_step || pipelineState?.agent_display_name);
    const currentSceneKey = currentStepId ? TRADING_AGENT_SCENE_MAP[currentStepId] : null;
    const currentScene = currentSceneKey ? STEP_SCENES[currentSceneKey] : null;
    const currentAgentName = normalizeTradingAgentName(currentStepId) || pipelineState?.agent_display_name;
    const sceneLiveLines = currentSceneKey
        ? (pipelineState?.live_step_dialogue?.[currentSceneKey] || [])
        : [];
    const liveLineForAgent = sceneLiveLines.find((line) => (
        normalizeTradingAgentName(line?.agent) === currentAgentName
    ));
    
    let agentName = 'SYSTEM';
    let rawMessage = '';
    const shouldShowTradingAgentsBootMessage = false;
    
    if (activeScene && sceneDialogue.length > 0) {
        agentName = currentDialogueLine?.agent || activeScene.agents?.[0] || 'AGENT';
        rawMessage = currentDialogueLine?.text || '';
    } else if (!isTradingAgentsMode && activeDialogue?.text) {
        agentName = activeDialogue.agent || 'SYSTEM';
        rawMessage = activeDialogue.text;
    } else if (!isTradingAgentsMode && liveLineForAgent?.text) {
        agentName = liveLineForAgent.agent || currentAgentName || 'SYSTEM';
        rawMessage = liveLineForAgent.text || '';
    } else {
        if (shouldShowTradingAgentsBootMessage) {
            rawMessage = `TradingAgents desk live for ${currentTicker}. Waiting on the first canonical floor scene.`;
            agentName = 'SYSTEM';
        } else if (isTradingAgentsMode && pipelineState?.scene_config_missing) {
            rawMessage = String(
                pipelineState?.scene_config_warning ||
                'Pipeline scenes config is missing. Open Pipeline Scenes, save the timeline scenes, then start a new run.'
            );
            agentName = 'SYSTEM';
        } else if (isTradingAgentsMode) {
            rawMessage = '';
            agentName = 'SYSTEM';
        } else if (currentTicker && currentAgentName && currentScene) {
            const stepNum = pipelineState?.phase_num || 0;
            const stepLabel = stepNum ? `Step ${stepNum}/5` : 'Step';
            rawMessage = `${stepLabel} — ${currentScene.name} report. Agent: ${currentAgentName}.`;
            agentName = 'SYSTEM';
        } else if (currentTicker) {
            rawMessage = `Analyzing ${currentTicker}... Awaiting current step details.`;
            agentName = 'SYSTEM';
        } else {
            rawMessage = "Waiting for the next pipeline target...";
            agentName = "SYSTEM";
        }
    }
    const bubbleMessage = compactDialogueForBubble(rawMessage);

    useEffect(() => {
        if (activeScene) {
            setCurrentDialogueIndex(0);
            setDialogueComplete(false);
            hasReturnedAgents.current = false;
            setIsPaused(false);
        }
    }, [activeScene?.headline]);

    useEffect(() => {
        if (!sceneControl?.action) return;
        const action = sceneControl.action;
        if (action === 'pause') {
            setIsPaused(true);
        } else if (action === 'resume') {
            setIsPaused(false);
        } else if (action === 'skip') {
            if (activeScene && sceneDialogue.length > 0) {
                const lastIndex = sceneDialogue.length - 1;
                setCurrentDialogueIndex(lastIndex);
                setDisplayedText(sceneDialogue[lastIndex]?.text || '');
                setIsTyping(false);
                setDialogueComplete(true);
            }
        } else if (action === 'abort') {
            if (activeScene && sceneRef?.current?.returnAgentsToDesks) {
                sceneRef.current.returnAgentsToDesks(activeScene.agents);
            }
            setActiveScene(null);
            setCurrentDialogueIndex(0);
            setDisplayedText('');
            setIsTyping(false);
            setDialogueComplete(false);
            setIsPaused(false);
        }
    }, [sceneControl?.action]);

    useEffect(() => {
        if (isPaused) return;
        if (!bubbleMessage) {
            setDisplayedText('');
            setIsTyping(false);
            setDialogueComplete(false);
            return undefined;
        }
        let i = 0;
        setDisplayedText('');
        setIsTyping(true);
        setDialogueComplete(false);
        const typingDelayMs = shouldPersistCanonicalTimelineScene ? 16 : 35;
        const lineAdvanceDelayMs = shouldPersistCanonicalTimelineScene ? 550 : 2000;

        const typingInterval = setInterval(() => {
            const nextChar = bubbleMessage.slice(0, i + 1);
            setDisplayedText(nextChar);

            if (bubbleMessage[i] && bubbleMessage[i] !== ' ') {
                playBlip();
            }

            i++;
            if (i >= bubbleMessage.length) {
                clearInterval(typingInterval);
                setIsTyping(false);
                
                if (activeScene && sceneDialogue.length > 0) {
                    setTimeout(() => {
                        if (currentDialogueIndex < sceneDialogue.length - 1) {
                            setCurrentDialogueIndex(prev => prev + 1);
                        } else {
                            setDialogueComplete(true);
                        }
                    }, lineAdvanceDelayMs);
                } else {
                    setDialogueComplete(true);
                }
            }
        }, typingDelayMs);

        return () => clearInterval(typingInterval);
    }, [bubbleMessage, currentDialogueIndex, isPaused, shouldPersistCanonicalTimelineScene, activeScene, sceneDialogue.length]);

    useEffect(() => {
        if (dialogueComplete && activeScene && !hasReturnedAgents.current) {
            hasReturnedAgents.current = true;
            const clearDelayMs = shouldPersistCanonicalTimelineScene ? 1200 : 3000;
            const timeout = setTimeout(() => {
                if (!shouldRetainCanonicalSceneLayout && sceneRef?.current?.returnAgentsToDesks) {
                    sceneRef.current.returnAgentsToDesks(activeScene.agents);
                }
                if (shouldPersistCanonicalTimelineScene) {
                    window.dispatchEvent(new CustomEvent('tradingagents_canonical_scene_complete', {
                        detail: {
                            key: activeScene?.runId != null && activeScene?.sceneIndex != null
                                ? `${activeScene.runId}:${Number(activeScene.attempt ?? 1)}:${activeScene.sceneIndex}`
                                : null,
                            runId: activeScene?.runId || null,
                            attempt: activeScene?.attempt ?? null,
                            sceneIndex: activeScene?.sceneIndex ?? null,
                        }
                    }));
                    return;
                }
                setActiveScene(null);
                setCurrentDialogueIndex(0);
                setDialogueComplete(false);
            }, clearDelayMs);
            return () => clearTimeout(timeout);
        }
    }, [dialogueComplete, activeScene, sceneRef, setActiveScene, shouldPersistCanonicalTimelineScene, shouldRetainCanonicalSceneLayout]);

    // Syncing with global TradingFloorContext.lightMode

    const portraitSrc = getAgentImageSrc(agentName);

    return (
        <div className="dialogue-shell">
            <div className="dialogue-left">
                <div className="dialogue-portrait">
                    <span className="dialogue-portrait-corner dialogue-portrait-corner--tl"></span>
                    <span className="dialogue-portrait-corner dialogue-portrait-corner--tr"></span>
                    <span className="dialogue-portrait-corner dialogue-portrait-corner--bl"></span>
                    <span className="dialogue-portrait-corner dialogue-portrait-corner--br"></span>
                    {portraitSrc ? (
                        <motion.img
                            key={agentName}
                            src={portraitSrc}
                            alt={agentName}
                            className="dialogue-portrait-img"
                            initial={{ scale: 1.05, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1, x: memeMode ? [0, -2, 2, 0] : 0 }}
                            transition={{ duration: 0.4, x: { repeat: Infinity, duration: 0.1 } }}
                        />
                    ) : null}
                </div>
            </div>

            <div className="dialogue-right-wrap">
                <div className="dialogue-header-outside">
                    {agentName.toUpperCase()} (LV. {hashString(agentName).toString().slice(0, 2)})
                </div>
                <div className="dialogue-header-line" />
                <div className="dialogue-right">
                    <div className="dialogue-body">
                        {displayedText}
                        {isTyping && <span className="dialogue-cursor">█</span>}
                    </div>
                    {dialogueComplete && !isTyping && (
                        <div className="dialogue-caret" />
                    )}
                </div>
            </div>

            <style>{`
                .dialogue-shell {
                    display: flex;
                    width: 100%;
                    height: 166px;
                    gap: 15px;
                    padding: 8px 12px;
                    font-family: 'Press Start 2P', cursive;
                    image-rendering: pixelated;
                    background: var(--metro-bg-main);
                    border: var(--metro-surface-border);
                    box-shadow: var(--metro-surface-shadow);
                    filter: var(--metro-panel-filter);
                    border-radius: 12px;
                    box-sizing: border-box;
                    align-items: stretch;
                }

                .dialogue-left {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                    width: 130px;
                    box-sizing: border-box;
                }

                .dialogue-portrait {
                    width: 120px;
                    height: 100%;
                    border: var(--metro-inset-border);
                    background: var(--metro-bg-deep);
                    box-shadow: var(--metro-surface-inset);
                    position: relative;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    overflow: visible; /* Allow corners to peek */
                }

                .dialogue-portrait-img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    object-position: center 18%;
                    image-rendering: pixelated;
                    display: block;
                    transform: scale(2.05);
                    transform-origin: center 18%;
                    /* Full color image as requested */
                    filter: none;
                }

                .dialogue-portrait-corner {
                    position: absolute;
                    width: 18px;
                    height: 18px;
                    background: var(--border-primary);
                    border: 2px solid var(--metro-shadow-deep);
                    box-shadow: inset -1px -1px 0 var(--metro-frame-inner-dark), inset 1px 1px 0 var(--metro-frame-inner-light);
                    box-sizing: border-box;
                    z-index: 10;
                }

                .dialogue-portrait-corner--tl { top: -6px; left: -6px; border-right: 0; border-bottom: 0; }
                .dialogue-portrait-corner--tr { top: -6px; right: -6px; border-left: 0; border-bottom: 0; }
                .dialogue-portrait-corner--bl { bottom: -6px; left: -6px; border-right: 0; border-top: 0; }
                .dialogue-portrait-corner--br { bottom: -6px; right: -6px; border-left: 0; border-top: 0; }

                .dialogue-right-wrap {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    flex: 1;
                    height: 100%;
                    min-height: 0;
                    padding-bottom: 4px;
                }

                .dialogue-header-outside {
                    font-size: 15px;
                    color: var(--metro-text-primary);
                    letter-spacing: 1.5px;
                    text-transform: uppercase;
                    padding-left: 2px;
                    line-height: 1;
                    text-shadow: 1px 1px 0 var(--metro-shadow-deep);
                }

                .dialogue-header-line {
                    height: 2px;
                    background: var(--border-primary);
                    opacity: 0.7;
                }

                .dialogue-right {
                    position: relative;
                    border: var(--metro-inset-border);
                    background: var(--metro-bg-deep);
                    color: var(--metro-text-secondary);
                    padding: 4px;
                    box-shadow: var(--metro-inset-shadow);
                    display: flex;
                    flex-direction: column;
                    justify-content: flex-start;
                    flex: 1;
                    min-height: 0;
                    border-radius: 4px;
                    overflow: hidden;
                }

                /* Speech Bubble Tail - 100% Match Shape from Image */
                .dialogue-right::before {
                    content: "";
                    position: absolute;
                    left: -15px;
                    top: 25px;
                    width: 12px;
                    height: 12px;
                    background: var(--metro-bg-deep);
                    border-left: 2px solid var(--metro-border);
                    border-bottom: 2px solid var(--metro-border);
                    transform: rotate(45deg);
                    z-index: 5;
                }

                .dialogue-body {
                    font-family: 'VT323', monospace;
                    font-size: 28px;
                    line-height: 1.1;
                    color: var(--metro-text-secondary);
                    text-align: left;
                    white-space: pre-wrap;
                    padding: 12px 20px;
                    letter-spacing: 0.5px;
                    flex: 1;
                    min-height: 0;
                    overflow: hidden;
                }

                .dialogue-cursor {
                    display: inline-block;
                    margin-left: 4px;
                    width: 12px;
                    height: 24px;
                    background: var(--metro-text-primary);
                    animation: dbpBlink 0.8s infinite;
                    vertical-align: middle;
                }

                @keyframes dbpBlink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0; }
                }

                .dialogue-caret {
                    position: absolute;
                    right: 20px;
                    bottom: 12px;
                    width: 0;
                    height: 0;
                    border-left: 10px solid transparent;
                    border-right: 10px solid transparent;
                    border-top: 14px solid var(--metro-text-primary);
                    animation: dbpFloat 1.2s ease-in-out infinite;
                }

                @keyframes dbpFloat {
                    0%, 100% { transform: translateY(0); }
                    50% { transform: translateY(5px); }
                }

            `}</style>
        </div>
    );
}

DialogueBoxPanel.propTypes = {
    currentTicker: PropTypes.string,
    pipelinePhase: PropTypes.string,
    sceneRef: PropTypes.object
};

export default DialogueBoxPanel;
