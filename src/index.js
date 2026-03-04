import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import session from 'express-session'
import connectPgSimple from 'connect-pg-simple'
import { pool } from './lib/db.js'
import { fail } from './lib/response.js'

import authRoutes          from './routes/auth.js'
import publicRoutes        from './routes/public.js'
import projectRoutes       from './routes/projects.js'
import supervisorRoutes    from './routes/supervisor.js'
import adminRoutes         from './routes/admin.js'
import aiRoutes            from './routes/ai.js'
import commentRoutes       from './routes/comments.js'
import userRoutes          from './routes/users.js'
import bookmarkRoutes      from './routes/bookmarks.js'
import notificationRoutes  from './routes/notifications.js'
import changeRequestRoutes from './routes/changeRequests.js'
import updateRoutes        from './routes/update.js'

const app = express()
app.set('trust proxy', 1)

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean)

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error(`CORS blocked: ${origin}`))
  },
  credentials: true,
}))

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// ── Session store (PostgreSQL) ────────────────────────────────
const PgStore = connectPgSimple(session)
const sessionStore = new PgStore({
  pool,
  tableName: 'session',
  createTableIfMissing: false,
})

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}))

// ── Static files ──────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/inquisia-backend/uploads'
app.use('/files', express.static(UPLOAD_DIR))

// ── Routes ───────────────────────────────────────────────────
// NOTE: Order matters. More specific paths must come before generic ones.
app.use('/api/auth',          authRoutes)
app.use('/api',               publicRoutes)
app.use('/api/ai',            aiRoutes)            // /api/ai/elara, /api/ai/validate, etc.
app.use('/api/projects',      projectRoutes)        // /api/projects/* (project CRUD)
app.use('/api/projects',      aiRoutes)             // /api/projects/:id/ai/* (project AI)
app.use('/api/supervisor',    supervisorRoutes)
app.use('/api/admin',         adminRoutes)
app.use('/api',               commentRoutes)        // /api/projects/:id/comments, /api/comments/:id
app.use('/api/users',         userRoutes)
app.use('/api/bookmarks',     bookmarkRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api',               changeRequestRoutes)
app.use('/api/update',        updateRoutes)

app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))
app.use((_req, res) => fail(res, 'Not found', 404))

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err)
  if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 'File too large. Maximum size is 50 MB.', 413)
  if (err.message?.startsWith('Only PDF')) return fail(res, err.message, 400)
  if (err.message?.startsWith('CORS')) return fail(res, err.message, 403)
  const status = err.status || err.statusCode || 500
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error' : err.message || 'Internal server error'
  fail(res, message, status)
})

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Inquisia] Server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`)
})
