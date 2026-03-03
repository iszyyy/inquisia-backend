import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import session from 'express-session'
import connectPgSimple from 'connect-pg-simple'
import { createClient } from 'redis'
import { RedisStore } from 'connect-redis'
import { pool } from './lib/db.js'
import { fail } from './lib/response.js'

// ── Route modules ────────────────────────────────────────────
import authRoutes        from './routes/auth.js'
import publicRoutes      from './routes/public.js'
import projectRoutes     from './routes/projects.js'
import supervisorRoutes  from './routes/supervisor.js'
import adminRoutes       from './routes/admin.js'
import aiRoutes          from './routes/ai.js'
import commentRoutes     from './routes/comments.js'
import userRoutes        from './routes/users.js'
import bookmarkRoutes    from './routes/bookmarks.js'
import notificationRoutes from './routes/notifications.js'
import changeRequestRoutes from './routes/changeRequests.js'

const app = express()

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

app.use(cors({
  origin: (origin, cb) => {
    // Allow non-browser requests (curl, Postman) in dev
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error(`CORS blocked: ${origin}`))
  },
  credentials: true,
}))

// ── Security / Logging ───────────────────────────────────────
app.use(helmet())
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// ── Session store (Redis) ─────────────────────────────────────
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' })
redisClient.on('error', (err) => console.error('[Redis]', err))
await redisClient.connect()

const sessionStore = new RedisStore({ client: redisClient, prefix: 'inq:' })

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}))

// ── Static file serving (uploaded PDFs) ──────────────────────
// Nginx handles /files/* → UPLOAD_DIR, but we serve it here as a fallback
import { fileURLToPath } from 'url'
import path from 'path'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/inquisia-backend/uploads'
app.use('/files', express.static(UPLOAD_DIR))

// ── Routes ───────────────────────────────────────────────────
app.use('/api/auth',          authRoutes)
app.use('/api',               publicRoutes)          // /api/public/stats, /api/departments, etc.
app.use('/api/projects',      projectRoutes)
app.use('/api/supervisor',    supervisorRoutes)
app.use('/api/admin',         adminRoutes)
app.use('/api/ai',            aiRoutes)
app.use('/api',               commentRoutes)          // /api/projects/:id/comments, /api/comments/:id
app.use('/api/users',         userRoutes)
app.use('/api/bookmarks',     bookmarkRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api',               changeRequestRoutes)    // /api/change-requests/:id/resolve

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

// ── 404 ──────────────────────────────────────────────────────
app.use((_req, res) => fail(res, 'Not found', 404))

// ── Global error handler ─────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err)

  if (err.code === 'LIMIT_FILE_SIZE') {
    return fail(res, 'File too large. Maximum size is 50 MB.', 413)
  }
  if (err.message?.startsWith('Only PDF')) {
    return fail(res, err.message, 400)
  }
  if (err.message?.startsWith('CORS')) {
    return fail(res, err.message, 403)
  }

  const status = err.status || err.statusCode || 500
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message || 'Internal server error'

  fail(res, message, status)
})

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Inquisia] Server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`)
})
