# Session Server Plan

- Add pluggable runtime backends beyond `DangerousBackend`, especially Docker-backed isolation.
- Persist session metadata to a database and survive server restarts.
- Add admin-grade session controls: force terminate, drain, transfer, and audit export.
- Enforce richer per-session policy: runtime selection, volume mounts, network policy, and quotas.
