# Inquisia Backend

Node.js + Express + PostgreSQL backend for the Inquisia research repository platform.

## Stack
- **Runtime:** Node.js (ESM)
- **Framework:** Express 4
- **Database:** PostgreSQL 16 (local)
- **Sessions:** Redis + connect-redis
- **Auth:** bcryptjs + express-session (cookie-based)
- **File uploads:** Multer (local disk → `/opt/inquisia-backend/uploads`)
- **AI:** OpenAI API
- **Process manager:** PM2

## Project Structure
```
src/
  index.js              # App entry — Express setup, middleware, route mounting
  lib/
    db.js               # pg Pool + query/transaction helpers
    response.js         # ok(), fail(), asyncHandler()
  middleware/
    auth.js             # requireAuth, requireRole, requireVerified, requireActive
    upload.js           # Multer PDF config
  routes/
    auth.js             # POST /api/auth/{login,register,logout}, GET /api/auth/session
    public.js           # GET /api/public/stats, /departments, /ai-categories, /supervisors
    projects.js         # Full project CRUD + versions, download, change-request, revision
    supervisor.js       # GET /api/supervisor/{projects,change-requests}
    admin.js            # Admin CRUD for users, projects, departments, categories
    ai.js               # /api/ai/{assistant,elara,validate,suggest-categories}
                        # /api/projects/:id/ai/{summary,analysis,chat}
    comments.js         # Threaded comments CRUD
    users.js            # GET/PATCH /api/users/:id, GET /api/users/lookup
    bookmarks.js        # /api/bookmarks CRUD
    notifications.js    # /api/notifications list + mark-all-read
    changeRequests.js   # PATCH /api/change-requests/:id/resolve
schema.sql              # Full PostgreSQL schema + seed data
ecosystem.config.cjs    # PM2 config
deploy.sh               # One-shot server setup script
nginx.conf.example      # Nginx config snippet
.env.example            # Environment variables template
```

## Phase Roadmap
- [x] **Phase 1** — Project scaffold, DB schema, auth routes, public routes
- [ ] **Phase 2** — Project routes (upload/browse/detail/status/versions/download)
- [ ] **Phase 3** — Supervisor routes + change request workflow
- [ ] **Phase 4** — Admin routes
- [ ] **Phase 5** — AI routes (Elara, validate, summary, analysis, chat)
- [ ] **Phase 6** — Comments, bookmarks, notifications, user profile
- [ ] **Phase 7** — Deployment & hardening

## Quick Start (dev)
```bash
cp .env.example .env   # Fill in DATABASE_URL, SESSION_SECRET, etc.
npm install
node src/index.js
```

## Deployment
```bash
# Copy files to server
scp -r . ubuntu@100.31.197.160:/opt/inquisia-backend/

# On the server
chmod +x /opt/inquisia-backend/deploy.sh
sudo /opt/inquisia-backend/deploy.sh
```

## API Overview
All responses: `{ success: true, data: T }` or `{ success: false, error: string }`.  
Session auth via `httpOnly` cookie (`credentials: 'include'` on the frontend).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/auth/session | ✓ | Get current user |
| POST | /api/auth/login | — | Login |
| POST | /api/auth/register | — | Register |
| POST | /api/auth/logout | ✓ | Logout |
| GET | /api/public/stats | — | Platform stats |
| GET | /api/departments | — | All departments |
| GET | /api/ai-categories | — | All AI categories |
| GET | /api/supervisors | — | Verified supervisors |
| GET | /api/projects/public | — | Browse (paginated, filtered) |
| GET | /api/projects/:id/public | — | Public project detail |
| POST | /api/projects | student | Submit project (multipart) |
| … | … | … | See routes/ for full list |
