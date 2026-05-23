# UI Client Plan

- Move Auth Center credentials from `~/.moss/settings.json` into macOS Keychain / Windows Credential Manager / Secret Service.
- Cache and refresh access tokens so each new session does not re-run the password or API-key exchange.
- Add explicit login/logout/session status UX instead of only saving connection settings.
- Support multiple enterprise profiles so one desktop client can switch across orgs, auth centers, and workspaces.
- Expose remote session inventory and termination controls in the desktop UI once server/admin APIs are stabilized.
