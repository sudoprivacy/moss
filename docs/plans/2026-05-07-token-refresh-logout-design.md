# Design Doc: Token Refresh and Logout Sync

**Date:** 2026-05-07
**Status:** Approved
**Topic:** Token Refresh and Logout Synchronization between Moss Server and Sudowork Client

## 1. Overview
The current authentication system uses JWT tokens with a 1-hour expiration. When the token expires, the client fails with 401 errors. Additionally, there is no way to revoke tokens on the server when a user logs out of the client.

This design introduces:
- A "pre-emptive refresh" mechanism in the client.
- A token revocation (blacklist) system in the server.
- New endpoints for refreshing tokens and logging out.

## 2. Server-side Changes (Moss Server)

### 2.1 Database (authcenter.db)
Add a new table `revoked_tokens` to store blacklisted token identifiers (`jti`).

```sql
CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revoked_tokens_expiry_idx ON revoked_tokens (expires_at);
```

### 2.2 Token Payload Enhancement
Update `src/server/auth/token.ts`:
- Include `jti` (unique ID) in `AccessTokenClaims`.
- Update `issueAccessToken` to generate a random `jti`.
- Update `verifyAccessToken` to (optionally) allow passing a callback to check if the `jti` is revoked.

### 2.3 AuthService Improvements
Update `src/server/auth/service.ts`:
- Implement `refreshToken(token: string)`: Validates a refresh token and issues a new access/refresh pair.
- Implement `logout(accessToken: string, refreshToken?: string)`: Adds the `jti` of both tokens to the `revoked_tokens` table.
- Update `issueToken`: Return both `access_token` and `refresh_token`.

### 2.4 API Routes
Update `src/server/server.ts`:
- `POST /api/v1/auth/token`: Support `grant_type: refresh_token`.
- `POST /api/v1/auth/logout`: Revoke current tokens.

## 3. Client-side Changes (Sudowork Client)

### 3.1 Bridge Logic (eeclawBridge.ts)
- **Token Management**:
    - Implement `getValidToken()`:
        1. Read `eeclaw.authStorage` from `ProcessConfig`.
        2. If `expires_at` - `Date.now()` < 5 minutes, call `/api/v1/auth/token` with `refresh_token`.
        3. Save new tokens to `ProcessConfig` and update caches.
        4. Use a mutex/lock to prevent concurrent refresh calls.
- **Request Interception**:
    - Update `getUserProfile`, `getCloudAssistants`, and other remote methods to use `getValidToken()` before making the actual fetch call.
- **Logout Sync**:
    - Implement `ipcBridge.eeclaw.logout`:
        1. Call server's `/api/v1/auth/logout`.
        2. Clear `ProcessConfig` and local caches.

## 4. Data Flow

### 4.1 Login
`Client --(Password/API Key)--> Server --(Access + Refresh + JTI)--> Client`

### 4.2 API Request (Pre-emptive)
`Client (Check expiry) --(Refreshes if needed)--> Client (Send req with valid token) --> Server`

### 4.3 Logout
`Client --(Logout Req)--> Server (Blacklist JTI) --(Success)--> Client (Clear Local Data)`

## 5. Security Considerations
- **Blacklist Cleanup**: A background task (or periodic cleanup during startup) should remove expired entries from `revoked_tokens` to keep the DB small.
- **JWT Integrity**: HMAC signing remains the same using the shared secret.

## 6. Implementation Plan
1. [Server] Create `revoked_tokens` table and database migration.
2. [Server] Update `token.ts` for `jti` support.
3. [Server] Update `AuthService` with refresh and logout logic.
4. [Server] Add API routes for token refresh and logout.
5. [Client] Implement token refresh logic in `eeclawBridge.ts`.
6. [Client] Integrate `getValidToken` into existing providers.
7. [Client] Implement logout sync.
