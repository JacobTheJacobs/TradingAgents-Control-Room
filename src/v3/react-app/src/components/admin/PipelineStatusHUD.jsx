import { motion } from 'framer-motion'

const PHASES = [
  { id: 1, label: 'ANALYSTS', desc: 'Analyst Team', phaseRange: [1, 1] },
  { id: 2, label: 'RESEARCH', desc: 'Research Team', phaseRange: [2, 2] },
  { id: 3, label: 'TRADER', desc: 'Trader', phaseRange: [3, 3] },
  { id: 4, label: 'RISK', desc: 'Risk Management', phaseRange: [4, 4] },
  { id: 5, label: 'PORTFOLIO', desc: 'Portfolio Management', phaseRange: [5, 5] }
]

export default function PipelineStatusHUD({ currentPhaseNum, currentPhase, ticker, cycleCount }) {
  return (
    <div className="bg-black/80 border-b border-highlight/30 p-1.5 backdrop-blur-md relative overflow-hidden">
      {/* Background Scanline pulse */}
      <motion.div 
        animate={{ opacity: [0.1, 0.3, 0.1] }}
        transition={{ duration: 2, repeat: Infinity }}
        className="absolute inset-0 bg-gradient-to-r from-transparent via-highlight/5 to-transparent pointer-events-none"
      />

      <div className="max-w-[1400px] mx-auto flex items-center gap-0.5.5 relative z-10">
        <div className="flex flex-col border-r border-white/10 pr-6">
          <span className="text-[9px] font-bold text-muted uppercase tracking-[0.2em]">Active Pipeline</span>
          <div className="flex items-baseline gap-0.5.5">
            <span className="text-[10px] font-black text-highlight data-mono tracking-tighter">{ticker || 'SYSTEM'}</span>
            <span className="text-[9px] font-bold text-accent tracking-widest uppercase">CYCLE #{cycleCount || 1}</span>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-5 gap-0.5 h-6">
          {PHASES.map((p) => {
            const isActive = currentPhaseNum >= p.phaseRange[0] && currentPhaseNum <= p.phaseRange[1]
            const isCompleted = currentPhaseNum > p.phaseRange[1]
            
            return (
              <div key={p.id} className="relative group">
                <div className={`h-full border transition-all duration-300 flex flex-col items-center justify-center ${
                  isActive ? 'bg-highlight/20 border-highlight shadow-[0_0_10px_rgba(0,255,255,0.2)]' :
                  isCompleted ? 'bg-accent/10 border-accent/40' :
                  'bg-white/5 border-white/10'
                }`}>
                  <span className={`text-[8px] font-bold ${
                    isActive ? 'text-highlight' :
                    isCompleted ? 'text-accent' :
                    'text-muted/50'
                  }`}>
                    {p.label}
                  </span>
                  
                  {isActive && (
                    <motion.div 
                      layoutId="active-indicator"
                      className="absolute -bottom-1 left-0 w-full h-[2px] bg-highlight"
                    />
                  )}
                </div>

                {/* Tooltip on hover */}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-1 bg-black border border-white/20 text-[9px] text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none uppercase tracking-tighter z-50">
                  Phase {p.id}: {p.desc}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex flex-col items-end w-32">
          <span className="text-[9px] font-bold text-muted uppercase tracking-[0.2em]">
            {PHASES.find(p => currentPhaseNum >= p.phaseRange[0] && currentPhaseNum <= p.phaseRange[1])?.id || (currentPhaseNum > 5 ? 5 : 0)}/5
          </span>
          <span className="text-[10px] font-bold text-accent truncate max-w-full italic">{currentPhase || 'IDLE'}</span>
        </div>
      </div>
    </div>
  )
}
