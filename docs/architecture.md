# TradingAgents Control Room Architecture

This repository adds an observability-oriented control surface around TradingAgents-style workflows.

## Main Pieces

### TradingAgents runner

The runner is the execution bridge to the upstream TradingAgents framework. In this repository it is exposed through the sidecar service so the UI and API can trigger or inspect runs without embedding upstream execution logic directly into the frontend.

Responsibilities:
- start workflow runs against the vendored upstream project
- keep upstream-specific dependencies isolated in the sidecar
- write artifacts and run outputs to shared storage

### Event adapter

The event adapter normalizes workflow progress into a UI-friendly shape. This is the boundary between raw TradingAgents execution details and the control room state model.

Responsibilities:
- translate upstream execution events into structured state updates
- preserve enough metadata for replay and audit trails
- allow future transport changes without rewriting the UI

### UI state renderer

The UI renderer consumes normalized state and turns it into a navigable operator interface. It is responsible for the visible timeline, decisions, and intermediate agent views.

Responsibilities:
- present agent progress in a readable sequence
- highlight decision points such as debate, trade, and risk review
- support both partial and fully replayed sessions

## Modes

### Replay mode

Replay mode is the lowest-risk path today. It renders stored or previously captured state transitions back into the interface so behavior can be inspected without depending on fully live streaming.

### Live mode

Live mode aims to reflect in-flight workflow activity while a run is executing. The current stack can operate in this direction, but the adapter boundary still needs refinement in some paths.

### Future WebSocket adapter

A dedicated WebSocket adapter is the intended long-term transport for low-latency streaming. The current architecture should keep that change isolated to the adapter layer rather than forcing a UI rewrite.

## Release Posture

This project should be read as an independent community interface for the TradingAgents ecosystem, not as an official Tauric Research product.