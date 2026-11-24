# Cabin latency and speech optimization

## Goal
Produce an actionable development design and implement evidence-backed optimizations on codex/cabin-status-mode-tools; preserve real hardware outcomes, language routing, history and recovery. Production deployment is a separate step.

## Phases
1. Inspect configuration, routing, audio and test integration: complete.
2. Write development design with rollout, limits and acceptance criteria: complete.
3. Implement exact greeting fast path, explicit TTS options, bounded fixed-reply cache and audio fingerprints: complete.
4. Run focused and Cabin regression checks; inspect changes: complete.
5. Record outcomes and remaining deployment/model work: complete.

## Expanded completion requested by user
6. Implement bounded compact Cabin inference without generic Agent transcript cost: complete.
7. Make stable Qwen TTS settings effective, bound synthesis duration, verify generated speech: complete.
8. Prepare model service split/cache deployment tooling and validate isolated production-host inference: complete.
9. Run full regression, deployment preparation and publish reproducible results: complete.
