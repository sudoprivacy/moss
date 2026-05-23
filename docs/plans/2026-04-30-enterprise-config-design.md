# Enterprise Configuration Design

## Overview
Implement an "Enterprise Information Configuration" feature in `moss-server`. This allows administrators to configure enterprise-level branding (Logo, Name, etc.) and provides a public API for clients to retrieve this information.

## Architecture

### Database Storage
A new table `enterprises` will be added to the SQLite database (`sessions.db`). Since this is a single-tenant deployment, only one record will be managed.

**Table: `enterprises`**
- `id`: TEXT PRIMARY KEY (always 'default')
- `logo`: TEXT (filename in storage)
- `app_name`: TEXT
- `top_name`: TEXT
- `about_name`: TEXT
- `app_company_name`: TEXT
- `login_desp`: TEXT
- `created_at`: INTEGER
- `updated_at`: INTEGER

### API Endpoints

1. **Get Configuration**
   - **URL**: `GET /api/v1/tenant/config`
   - **Auth**: None (Public)
   - **Response**:
     ```json
     {
       "success": true,
       "data": {
         "logo": "data:image/png;base64,...",
         "app_name": "...",
         "top_name": "...",
         "about_name": "...",
         "app_company_name": "...",
         "login_desp": "..."
       }
     }
     ```

2. **Update Configuration**
   - **URL**: `PATCH /api/v1/settings/enterprise`
   - **Auth**: Bearer Token (requires `admin:settings` scope)
   - **Body**: JSON matching the fields above.

3. **Upload Logo**
   - **URL**: `POST /api/v1/upload/logo`
   - **Auth**: Bearer Token (requires `admin:settings` scope)
   - **Body**: Multipart file upload.
   - **Storage**: `${runtimeDir}/uploads/enterprise/`

### Module Structure
- `src/server/db.ts`: Add table initialization and CRUD methods.
- `src/server/api/enterprise.ts`: Implement logic for Base64 conversion and request handling.
- `src/server/server.ts`: Register the new routes.

## Success Criteria
- [ ] Public endpoint returns correct configuration.
- [ ] Admin can update text fields.
- [ ] Admin can upload a logo and it is correctly served as Base64 in the config.
