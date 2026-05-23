# Design Doc: User Profile API

**Date:** 2026-04-30
**Status:** Approved
**Topic:** Implementation of `/api/v1/user/profile` endpoint

## 1. Overview
Create a new endpoint to provide authenticated users with their profile information, including organizational context (department, role) and resource usage statistics (token consumption and session count).

## 2. Architecture
The endpoint will be implemented within the existing `src/server/server.ts` request handling logic (or a separate controller if we decide to refactor). It will orchestrate data from multiple sources:
- **AuthCenterDb**: For user, department, and role information.
- **DirectConnectStore (SQLite)**: For session counts.
- **Filesystem (JSONL logs)**: For token usage via `budgetStats.ts` logic.

## 3. API Specification

### GET `/api/v1/user/profile`
**Authentication:** Required (Bearer Token)

**Success Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "username": "张三",
    "department": "技术部",
    "role": "普通用户",
    "usage": {
      "input_tokens": 5000,
      "output_tokens": 3000,
      "total_tokens": 8000,
      "session_count": 12
    }
  }
}
```

## 4. Implementation Details

### Data Fetching
1. **User Identity**: Extract `userId` and `orgId` from the verified `AuthContext`.
2. **Organization Context**:
   - Fetch user from `AuthCenterDb` by ID.
   - Join/Fetch department name from `departments` table using `department_id`.
   - Map `role` (admin, dept_admin, user) to display names (系统管理员, 部门管理员, 普通用户).
3. **Usage Stats**:
   - Query `sessions` table in `DirectConnectStore` for all records where `user_id = ?`.
   - `session_count` = count of records found.
   - For each session, use `loadBudgetStats` logic to scan `transcript_path` and sum up `inputTokens` and `outputTokens`.

### Performance Considerations
- Token usage calculation requires file I/O. For users with many sessions, this could be slow.
- Recommendation: Limit log scanning to sessions within a reasonable time window or implement a lightweight cache for usage totals.

## 5. Testing
- **Unit Tests**: Verify the data mapping logic (role names, department lookup).
- **Integration Tests**: Mock the filesystem and database to verify the endpoint returns correct totals.
- **Security**: Ensure users can only access their own profile.
