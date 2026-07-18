import PhaseCard from './PhaseCard'

const PHASE_ORDER = ['scout', 'pre_mortem', 'war_room', 'agents', 'oracle', 'predictions']

export default function PipelineConfig({ phases, providerOptions, onUpdatePhase }) {
  return (
    <div className="llm-section">
      <div className="llm-section__header">
        <h2 className="llm-section__title">Pipeline Phases</h2>
        <p className="llm-section__desc">Assign providers/models to each pipeline phase</p>
      </div>

      {/* Pipeline flow visualization */}
      <div className="llm-pipeline-flow">
        {PHASE_ORDER.map((phase, i) => (
          <div key={phase} className="llm-pipeline-flow__step">
            {i > 0 && <div className="llm-pipeline-flow__arrow" />}
            <PhaseCard
              phaseName={phase}
              config={phases?.[phase]}
              providerOptions={providerOptions}
              onUpdate={onUpdatePhase}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
