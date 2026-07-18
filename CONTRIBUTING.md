# Contributing

Thanks for contributing to TradingAgents Control Room.

This repository is an independent community project built for the TradingAgents ecosystem. Keep changes easy to review, explicit about risk, and clear about what is production-ready versus alpha.

## Principles

- do not imply official Tauric Research endorsement
- keep behavior non-breaking where possible
- document limitations instead of hiding them
- prefer small, reviewable pull requests
- keep Docker and manual run instructions accurate when behavior changes

## Development

Recommended local workflow:

```bash
docker compose -f docker-compose.yml up --build
```

Manual workflow is documented in `README.md`.

## Pull Requests

Please include:
- a short summary of the change
- why the change is useful
- any user-facing behavior change
- any known limitation or follow-up item
- updated docs when run instructions or architecture change

If your change affects runtime behavior, include the smallest validation you ran.

## Scope Guidance

Good contributions:
- observability improvements
- replay and timeline improvements
- adapter cleanup for live events
- documentation and onboarding fixes
- low-risk upstream integration improvements

Changes that need extra care:
- anything that could be interpreted as live trading support
- anything that removes or hides known alpha limitations
- any statement that implies official upstream affiliation

## Before Opening A PR

- run the Docker stack if your change affects runtime behavior
- update `docs/known-issues.md` if you discover a new limitation
- update `docs/architecture.md` if you change integration boundaries
- keep screenshots or demo assets sanitized before publishing