// Trading Floor Page - Backwards Compatibility Wrapper
// This file re-exports from the new modular architecture
// All logic has been moved to src/components/trading-floor/

export {
  default,
  TradingFloorPageContent
} from './trading-floor/TradingFloorPage'

export { TradingFloorGame } from './trading-floor/canvas/TradingFloorGame'

export {
  ActivityLog,
  AgentStatusPanel,
  CycleHistoryPanel
} from './trading-floor'
