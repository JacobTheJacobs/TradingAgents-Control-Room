# Known Issues

This repository is in alpha and these limitations are intentionally documented.

## Current Limitations

- Live event streaming may need adapter refinement before it is reliable across all workflow paths.
- Docker compatibility is still being tested outside the current local development setup.
- Some UI states may be mocked or replayed rather than sourced from fully live upstream events.
- The backend can fall back to compatibility routes when optional runtime modules are missing.
- The current frontend production build emits a large bundle warning.
- This project is not intended for live trading.

## Release Framing

These issues should be treated as visible alpha limitations, not hidden defects. The goal is to make review easier by being explicit about the current state of the system.