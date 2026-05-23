# Enterprise Configuration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add enterprise branding configuration (logo, names) with public and admin APIs.

**Architecture:** Use a dedicated SQLite table for storage and a modular API file to handle routes. Logos will be stored as files and served as Base64.

**Tech Stack:** TypeScript, Node.js http, SQLite (DatabaseSync), Zod (Validation).

---

### Task 1: Update Database Schema

**Files:**
- Modify: `src/server/db.ts`

**Step 1: Add table definition and migration logic**

In `DirectConnectStore` constructor:
```typescript
this.db.exec(`
  CREATE TABLE IF NOT EXISTS enterprises (
    id TEXT PRIMARY KEY,
    logo TEXT,
    app_name TEXT,
    top_name TEXT,
    about_name TEXT,
    app_company_name TEXT,
    login_desp TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Insert default record if not exists
this.db.prepare(`
  INSERT OR IGNORE INTO enterprises (id, app_name, created_at, updated_at)
  VALUES ('default', 'Moss', ?, ?)
`).run(Date.now(), Date.now());
```

**Step 2: Add CRUD methods to DirectConnectStore**

```typescript
getEnterprise() {
  return this.db.prepare('SELECT * FROM enterprises WHERE id = "default"').get();
}

updateEnterprise(patch: any) {
  const fields = Object.keys(patch).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(patch), Date.now()];
  this.db.prepare(`UPDATE enterprises SET ${fields}, updated_at = ? WHERE id = "default"`).run(...values);
}
```

### Task 2: Create Enterprise API Module

**Files:**
- Create: `src/server/api/enterprise.ts`

**Step 1: Implement base64 helper and handlers**

```typescript
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { DirectConnectStore } from '../db.js';

export function createEnterpriseApi(db: DirectConnectStore, runtimeDir: string) {
  return {
    async getConfig() {
      const enterprise = db.getEnterprise() as any;
      let logoBase64 = null;
      if (enterprise?.logo) {
        try {
          const logoPath = join(runtimeDir, 'uploads', 'enterprise', enterprise.logo);
          const buffer = await readFile(logoPath);
          const ext = enterprise.logo.split('.').pop();
          logoBase64 = `data:image/${ext};base64,${buffer.toString('base64')}`;
        } catch (e) {}
      }
      return {
        success: true,
        data: { ...enterprise, logo: logoBase64 }
      };
    },
    updateConfig(patch: any) {
      db.updateEnterprise(patch);
      return { success: true };
    }
  };
}
```

### Task 3: Register Routes in Server

**Files:**
- Modify: `src/server/server.ts`

**Step 1: Import and initialize API**
```typescript
import { createEnterpriseApi } from './api/enterprise.js';
// ... inside startServer
const enterpriseApi = createEnterpriseApi(runtime.store, config.runtimeDir);
```

**Step 2: Add Public Route**
```typescript
if (req.method === 'GET' && pathname === '/api/v1/tenant/config') {
  writeJson(res, 200, await enterpriseApi.getConfig());
  return;
}
```

**Step 3: Add Admin Update Route**
```typescript
if (req.method === 'PATCH' && pathname === '/api/v1/settings/enterprise') {
  authService.requireScope(auth, 'admin:settings');
  const body = await readJsonBody(req);
  writeJson(res, 200, enterpriseApi.updateConfig(body));
  return;
}
```

### Task 4: Implement Logo Upload

**Files:**
- Modify: `src/server/server.ts`

**Step 1: Add upload handler**
Handle `POST /api/v1/upload/logo`. Use `multipart/form-data` or simple body if preferred.
Since `server.ts` uses raw `http`, we might need a simple buffer-to-file logic.

```typescript
if (req.method === 'POST' && pathname === '/api/v1/upload/logo') {
  authService.requireScope(auth, 'admin:settings');
  // Logic to save file to config.runtimeDir + '/uploads/enterprise/'
}
```
