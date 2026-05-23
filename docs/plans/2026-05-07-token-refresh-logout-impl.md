# Token Refresh and Logout Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement pre-emptive token refresh and server-side token revocation to prevent 401 errors and sync logout state.

**Architecture:** 
1. Server: Add `revoked_tokens` table, support `jti` in JWT, and implement logout/refresh endpoints.
2. Client: Implement `getValidToken` wrapper with locking, and integrate it into all remote IPC providers.

**Tech Stack:** TypeScript, Node.js http, SQLite (DatabaseSync), JWT (HS256).

---

### Phase 1: Server-side (Moss) - Revocation Infrastructure

#### Task 1: Add `revoked_tokens` table to AuthCenterDb

**Files:**
- Modify: `src/server/authCenter/db.ts:192-246`

**Step 1: Update `initTables` to include `revoked_tokens`**

```typescript
// Inside initTables
this.db.exec(`
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS revoked_tokens_expiry_idx ON revoked_tokens (expires_at);
`);
```

**Step 2: Add revocation methods to `AuthCenterDb` class**

```typescript
revokeToken(jti: string, expiresAt: number): void {
  this.db.prepare(`
    INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)
  `).run(jti, expiresAt)
}

isTokenRevoked(jti: string): boolean {
  const row = this.db.prepare(`
    SELECT 1 FROM revoked_tokens WHERE jti = ? LIMIT 1
  `).get(jti)
  return !!row
}

cleanupExpiredRevokedTokens(): void {
  this.db.prepare(`
    DELETE FROM revoked_tokens WHERE expires_at < ?
  `).run(Date.now())
}
```

**Step 3: Commit**
```bash
git add src/server/authCenter/db.ts
git commit -m "feat(auth): add revoked_tokens table and DB methods"
```

#### Task 2: Enhance JWT with `jti` support

**Files:**
- Modify: `src/server/auth/token.ts:3-145`

**Step 1: Add `jti` to `AccessTokenClaims` and `AuthContext` types**

```typescript
export type AccessTokenClaims = {
  // ...
  jti: string // Add this
  type: 'access' | 'refresh' // Update this
  // ...
}

export type AuthContext = {
  // ...
  jti: string
}
```

**Step 2: Update `issueAccessToken` to generate `jti`**

```typescript
export function issueAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'type' | 'jti'>,
  secret: string,
  expiresInSec = 60 * 60,
  type: 'access' | 'refresh' = 'access'
) {
  const jti = randomUUID() // Need to import randomUUID
  // ... build payload including jti and type
}
```

**Step 3: Update `verifyAccessToken` to handle `jti` and type**

```typescript
// ... return jti in AuthContext
```

**Step 4: Commit**
```bash
git add src/server/auth/token.ts
git commit -m "feat(auth): add jti and token type to JWT claims"
```

#### Task 3: Implement Logout and Refresh in AuthService

**Files:**
- Modify: `src/server/auth/service.ts`

**Step 1: Implement `logout` and `refreshToken` methods**
```typescript
// ... issue both access and refresh tokens in issueToken
// ... add logout method to call db.revokeToken
// ... add verifyTokenAndCheckRevocation helper
```

**Step 2: Commit**
```bash
git add src/server/auth/service.ts
git commit -m "feat(auth): implement refresh and logout logic in AuthService"
```

#### Task 4: Expose API Endpoints

**Files:**
- Modify: `src/server/server.ts`

**Step 1: Implement `/api/v1/auth/token` (refresh_token) and `/api/v1/auth/logout`**

**Step 2: Commit**
```bash
git add src/server/server.ts
git commit -m "feat(auth): add token refresh and logout API endpoints"
```

---

### Phase 2: Client-side (Sudowork) - Pre-emptive Refresh

#### Task 5: Implement `getValidToken` helper in Client Bridge

**Files:**
- Modify: `src/process/bridge/eeclawBridge.ts`

**Step 1: Add refresh locking and `getValidToken` logic**
```typescript
let refreshPromise: Promise<string> | null = null;

async function getValidToken(): Promise<string> {
  const authStorage = await ProcessConfig.get('eeclaw.authStorage');
  if (!authStorage) throw new Error('Not logged in');

  const buffer = 5 * 60 * 1000; // 5 mins
  if (Date.now() < authStorage.expires_at - buffer) {
    return authStorage.access_token;
  }

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      // call refresh API...
      // update ProcessConfig and caches...
      return newAccessToken;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}
```

**Step 2: Wrap all remote providers with `getValidToken`**
Update `getUserProfile`, `getCloudAssistants`, etc.

**Step 3: Implement Logout IPC**
Update `logout` provider to call server then clear local.

**Step 4: Commit**
```bash
git add src/process/bridge/eeclawBridge.ts
git commit -m "feat(client): implement pre-emptive token refresh and logout sync"
```
