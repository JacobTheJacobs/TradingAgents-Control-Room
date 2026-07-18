"""
Minimal runtime package marker for TA-only strict backend mode.

In this deployment, TradingAgents canonical scene flow is served by
`admin_compat` + `trading_floor_compat` with strict canonical enforcement.
Legacy autonomous runtime modules are intentionally out of scope.
"""

TA_ONLY_RUNTIME = True
