# Auth Module Plan

- Replace shared-secret HS256 with asymmetric signing and key rotation.
- Add refresh tokens, revocation lists, and shorter-lived worker/session tokens.
- Add richer RBAC and policy evaluation instead of scope string matching.
- Add audit hooks for every auth failure and authorization denial.
