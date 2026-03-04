/**
 * Inquisia Update System — Hardened
 * ──────────────────────────────────────────────────────────────
 * GET  /api/update/status          — server info, git log, uptime
 * GET  /api/update/logs            — tail PM2 logs
 * GET  /api/update/history         — deployment history from DB
 * GET  /api/update/releases        — list available rollback snapshots
 * POST /api/update/files           — upload individual backend files
 * POST /api/update/zip             — upload backend zip
 * POST /api/update/frontend-zip    — upload pre-built frontend dist zip
 * POST /api/update/git-pull        — git pull + restart
 * POST /api/update/restart         — restart PM2 only
 * POST /api/update/rollback/:label — restore a previous snapshot
 * POST /api/update/env             — update whitelisted .env vars
 * POST /api/update/maintenance     — toggle maintenance mode
 *
 * All routes require admin role.
 * Destructive routes also require deployment lock.
 */

import { Router }              from 'express'
import { requireRole, requireActive } from '../middleware/auth.js'
import multer                  from 'multer'
import { execSync, exec }      from 'child_process'
import fs                      from 'fs'
import path                    from 'path'
import crypto                  from 'crypto'
import { fileURLToPath }       from 'url'
import AdmZip                  from 'adm-zip'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { query }               from '../lib/db.js'

const router    = Router()
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BACKEND_ROOT  = path.resolve(__dirname, '../../')
const FRONTEND_ROOT = '/var/www/inquisia.iszy.cloud'
const PM2_APP_NAME  = 'inquisia-backend'
const RELEASES_DIR  = path.join(BACKEND_ROOT, 'releases')
const MAX_RELEASES  = 10

// ── Allowed .env keys (never SESSION_SECRET or DATABASE_URL) ──
const ALLOWED_ENV_KEYS = [
  'CORS_ORIGINS', 'FILE_BASE_URL', 'UPLOAD_DIR',
  'NODE_ENV', 'PORT', 'REDIS_URL', 'OPENAI_API_KEY',
]

// ── Auth guard ────────────────────────────────────────────────
const isAdmin = [requireRole('admin'), requireActive]

// ── Multer ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, '/tmp'),
    filename:    (_req, file, cb)  => cb(null, `inq_${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
})

// ─────────────────────────────────────────────────────────────
// DEPLOYMENT LOCK (in-memory mutex)
// ─────────────────────────────────────────────────────────────
const deployLock = { active: false, userId: null, startedAt: null }

function acquireLock(userId) {
  if (deployLock.active) {
    return { ok: false, userId: deployLock.userId, startedAt: deployLock.startedAt }
  }
  deployLock.active    = true
  deployLock.userId    = userId
  deployLock.startedAt = new Date().toISOString()
  return { ok: true }
}

function releaseLock() {
  deployLock.active    = false
  deployLock.userId    = null
  deployLock.startedAt = null
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function run(cmd, cwd = BACKEND_ROOT) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 120000 }).trim()
  } catch (e) {
    return e.message || String(e)
  }
}

function runAsync(cmd, cwd = BACKEND_ROOT) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, encoding: 'utf8', timeout: 180000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err: err?.message })
    })
  })
}

function safePath(base, relative) {
  const normalized = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '')
  const resolved   = path.resolve(base, normalized)
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error(`Path traversal attempt blocked: ${relative}`)
  }
  return resolved
}

function nowLabel() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-')
}

// ─────────────────────────────────────────────────────────────
// SNAPSHOT / ROLLBACK
// ─────────────────────────────────────────────────────────────
function snapshotBackend(label) {
  const dest = path.join(RELEASES_DIR, 'backend', label)
  fs.mkdirSync(dest, { recursive: true })
  run(`cp -r ${path.join(BACKEND_ROOT, 'src')} ${dest}/`)
  const envPath = path.join(BACKEND_ROOT, '.env')
  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, path.join(dest, '.env.bak'))
  }
  pruneReleases(path.join(RELEASES_DIR, 'backend'))
  return dest
}

function snapshotFrontend(label) {
  const dist = path.join(FRONTEND_ROOT, 'dist')
  const dest = path.join(RELEASES_DIR, 'frontend', label)
  fs.mkdirSync(dest, { recursive: true })
  if (fs.existsSync(dist)) {
    run(`cp -r ${dist} ${dest}/`)
  }
  pruneReleases(path.join(RELEASES_DIR, 'frontend'))
  return dest
}

function restoreBackend(snapshotPath) {
  const srcBackup = path.join(snapshotPath, 'src')
  const envBackup = path.join(snapshotPath, '.env.bak')
  if (!fs.existsSync(srcBackup)) throw new Error('Snapshot src/ not found')
  run(`rm -rf ${path.join(BACKEND_ROOT, 'src')}`)
  run(`cp -r ${srcBackup} ${path.join(BACKEND_ROOT, 'src')}`)
  if (fs.existsSync(envBackup)) {
    fs.copyFileSync(envBackup, path.join(BACKEND_ROOT, '.env'))
  }
}

function restoreFrontend(snapshotPath) {
  const distBackup = path.join(snapshotPath, 'dist')
  const dist       = path.join(FRONTEND_ROOT, 'dist')
  if (!fs.existsSync(distBackup)) throw new Error('Snapshot dist/ not found')
  run(`rm -rf ${dist}`)
  run(`cp -r ${distBackup} ${dist}`)
  run(`chown -R www-data:www-data ${dist}`)
  run(`chmod -R 755 ${dist}`)
}

function pruneReleases(dir) {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir)
    .map(name => ({ name, mtime: fs.statSync(path.join(dir, name)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const entry of entries.slice(MAX_RELEASES)) {
    run(`rm -rf ${path.join(dir, entry.name)}`)
  }
}

function listSnapshots(type) {
  const dir = path.join(RELEASES_DIR, type)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .map(name => ({
      label: name,
      created_at: fs.statSync(path.join(dir, name)).mtime.toISOString(),
    }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
async function waitForHealth(retries = 6, delayMs = 2500) {
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, delayMs))
    try {
      const { default: fetch } = await import('node-fetch').catch(() => ({ default: global.fetch }))
      const res  = await fetch('http://localhost:3000/api/health', { timeout: 5000 })
      const json = await res.json()
      if (json.status === 'ok') return { ok: true, attempts: i + 1 }
    } catch {}
  }
  return { ok: false, attempts: retries }
}

// ─────────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────────
async function logDeployment({ triggered_by, action_type, snapshot_label, duration_ms, success, error_message, rollback_used, metadata }) {
  try {
    await query(
      `INSERT INTO deployment_history
         (triggered_by, action_type, snapshot_label, duration_ms, success, error_message, rollback_used, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [triggered_by, action_type, snapshot_label || null, duration_ms, success, error_message || null, rollback_used || false, JSON.stringify(metadata || {})]
    )
  } catch (e) {
    console.error('[DeployLog] Failed to write deployment history:', e.message)
  }
}

// ─────────────────────────────────────────────────────────────
// SAFE ZIP EXTRACTION
// ─────────────────────────────────────────────────────────────
const BLOCKED_FILES = ['.env', 'ecosystem.config.cjs', 'package.json', 'package-lock.json']

function safeExtract(zip, destBase, allowedExts) {
  const MAX_FILES = 200
  const MAX_TOTAL = 50 * 1024 * 1024
  let totalSize   = 0
  let count       = 0
  const results   = []

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    if (++count > MAX_FILES) throw new Error(`Zip contains more than ${MAX_FILES} files`)

    const normalized = path.normalize(entry.entryName).replace(/^(\.\.(\/|\\|$))+/, '')
    const ext        = path.extname(normalized).toLowerCase()
    const basename   = path.basename(normalized)

    if (!allowedExts.includes(ext)) {
      results.push({ file: normalized, status: 'skipped', reason: 'disallowed extension' })
      continue
    }
    if (BLOCKED_FILES.includes(basename)) {
      results.push({ file: normalized, status: 'skipped', reason: 'protected file' })
      continue
    }

    const data = entry.getData()
    totalSize += data.length
    if (totalSize > MAX_TOTAL) throw new Error('Zip total size exceeds 50MB limit')

    const dest = path.join(destBase, normalized)
    if (!dest.startsWith(path.resolve(destBase))) {
      results.push({ file: normalized, status: 'skipped', reason: 'path traversal' })
      continue
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, data)
    results.push({ file: normalized, status: 'ok', size: data.length })
  }

  return results
}

// ─────────────────────────────────────────────────────────────
// GET /api/update/status
// ─────────────────────────────────────────────────────────────
router.get('/status', ...isAdmin, asyncHandler(async (_req, res) => {
  const gitLog    = run('git log --oneline -5')
  const gitBranch = run('git rev-parse --abbrev-ref HEAD')
  const gitStatus = run('git status --short')
  const pm2Raw    = run('pm2 jlist')
  const uptime    = run('uptime -p')
  const disk      = run('df -h / | tail -1')
  const mem       = run('free -m | grep Mem')
  const nodeVer   = run('node --version')

  let pm2Info = null
  try {
    const list = JSON.parse(pm2Raw)
    const app  = list.find(p => p.name === PM2_APP_NAME)
    if (app) {
      pm2Info = {
        status:    app.pm2_env?.status,
        restarts:  app.pm2_env?.restart_time,
        uptime:    app.pm2_env?.pm_uptime,
        memory_mb: Math.round((app.monit?.memory || 0) / 1024 / 1024),
        cpu_pct:   app.monit?.cpu,
      }
    }
  } catch {}

  return ok(res, {
    git: {
      branch:      gitBranch,
      recent_logs: gitLog.split('\n').filter(Boolean),
      dirty_files: gitStatus.split('\n').filter(Boolean),
    },
    pm2:    pm2Info,
    deploy: deployLock,
    system: { uptime, disk, memory: mem, node: nodeVer },
    releases: {
      backend:  listSnapshots('backend').slice(0, 5),
      frontend: listSnapshots('frontend').slice(0, 5),
    },
    timestamp: new Date().toISOString(),
  })
}))

// ─────────────────────────────────────────────────────────────
// GET /api/update/logs
// ─────────────────────────────────────────────────────────────
router.get('/logs', ...isAdmin, asyncHandler(async (req, res) => {
  const lines = Math.min(Math.max(parseInt(req.query.lines) || 50, 10), 500)
  const raw   = run(`pm2 logs ${PM2_APP_NAME} --lines ${lines} --nostream`)
  // Strip potential secrets from logs before returning
  const sanitized = raw
    .split('\n')
    .map(l => l.replace(/(password|secret|token|key)=\S+/gi, '$1=[REDACTED]'))
  return ok(res, { logs: sanitized })
}))

// ─────────────────────────────────────────────────────────────
// GET /api/update/history
// ─────────────────────────────────────────────────────────────
router.get('/history', ...isAdmin, asyncHandler(async (_req, res) => {
  const rows = await query(
    `SELECT dh.*, u.full_name AS triggered_by_name, u.email AS triggered_by_email
     FROM deployment_history dh
     LEFT JOIN users u ON u.id = dh.triggered_by
     ORDER BY dh.created_at DESC
     LIMIT 50`
  )
  return ok(res, rows)
}))

// ─────────────────────────────────────────────────────────────
// GET /api/update/releases
// ─────────────────────────────────────────────────────────────
router.get('/releases', ...isAdmin, asyncHandler(async (_req, res) => {
  return ok(res, {
    backend:  listSnapshots('backend'),
    frontend: listSnapshots('frontend'),
  })
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/files
// ─────────────────────────────────────────────────────────────
router.post('/files', ...isAdmin, upload.array('files', 30), asyncHandler(async (req, res) => {
  if (!req.files?.length) return fail(res, 'No files uploaded', 400)

  const lock = acquireLock(req.session.userId)
  if (!lock.ok) return fail(res, `Deploy in progress since ${lock.startedAt}`, 423)

  const start    = Date.now()
  const label    = `${nowLabel()}_files`
  const snapshot = snapshotBackend(label)
  const targetDir = req.body.target_dir || 'src/routes'
  const results  = []
  let success    = false
  let errorMsg   = null

  try {
    for (const file of req.files) {
      try {
        const destDir  = safePath(BACKEND_ROOT, targetDir)
        const destFile = path.join(destDir, file.originalname)
        fs.mkdirSync(destDir, { recursive: true })
        fs.copyFileSync(file.path, destFile)
        fs.unlinkSync(file.path)
        results.push({ file: file.originalname, status: 'ok' })
      } catch (e) {
        results.push({ file: file.originalname, status: 'error', error: e.message })
      }
    }

    run(`pm2 restart ${PM2_APP_NAME} --update-env`)
    const health = await waitForHealth()

    if (!health.ok) {
      restoreBackend(snapshot)
      run(`pm2 restart ${PM2_APP_NAME} --update-env`)
      throw new Error('Health check failed after deploy — auto-rolled back')
    }

    success = true
    return ok(res, {
      results,
      snapshot: label,
      health_check: health,
      message: `${results.filter(r => r.status === 'ok').length} file(s) deployed. Health check passed.`,
    })
  } catch (e) {
    errorMsg = e.message
    return fail(res, e.message, 500)
  } finally {
    releaseLock()
    await logDeployment({
      triggered_by:   req.session.userId,
      action_type:    'files',
      snapshot_label: label,
      duration_ms:    Date.now() - start,
      success,
      error_message:  errorMsg,
      metadata:       { files: results.map(r => r.file), target_dir: targetDir },
    })
  }
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/zip  (backend zip)
// ─────────────────────────────────────────────────────────────
router.post('/zip', ...isAdmin, upload.single('zip'), asyncHandler(async (req, res) => {
  if (!req.file) return fail(res, 'No zip file uploaded', 400)
  if (!req.file.originalname.endsWith('.zip')) return fail(res, 'File must be a .zip', 400)

  const lock = acquireLock(req.session.userId)
  if (!lock.ok) return fail(res, `Deploy in progress since ${lock.startedAt}`, 423)

  const start    = Date.now()
  const label    = `${nowLabel()}_zip`
  const snapshot = snapshotBackend(label)
  let results    = []
  let success    = false
  let errorMsg   = null

  try {
    const zip = new AdmZip(req.file.path)
    results   = safeExtract(zip, BACKEND_ROOT, ['.js', '.json', '.sql', '.md', '.cjs', '.mjs', '.ts'])
    fs.unlinkSync(req.file.path)

    run(`pm2 restart ${PM2_APP_NAME} --update-env`)
    const health = await waitForHealth()

    if (!health.ok) {
      restoreBackend(snapshot)
      run(`pm2 restart ${PM2_APP_NAME} --update-env`)
      throw new Error('Health check failed after deploy — auto-rolled back')
    }

    success = true
    return ok(res, {
      results,
      snapshot: label,
      health_check: health,
      message: `${results.filter(r => r.status === 'ok').length} file(s) extracted. Health check passed.`,
    })
  } catch (e) {
    errorMsg = e.message
    try { fs.unlinkSync(req.file.path) } catch {}
    return fail(res, e.message, 500)
  } finally {
    releaseLock()
    await logDeployment({
      triggered_by:   req.session.userId,
      action_type:    'zip',
      snapshot_label: label,
      duration_ms:    Date.now() - start,
      success,
      error_message:  errorMsg,
      metadata:       { extracted: results.filter(r => r.status === 'ok').length },
    })
  }
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/frontend-zip
// ─────────────────────────────────────────────────────────────
router.post('/frontend-zip', ...isAdmin, upload.single('zip'), asyncHandler(async (req, res) => {
  if (!req.file) return fail(res, 'No zip file uploaded', 400)
  if (!req.file.originalname.endsWith('.zip')) return fail(res, 'File must be a .zip', 400)

  const lock = acquireLock(req.session.userId)
  if (!lock.ok) return fail(res, `Deploy in progress since ${lock.startedAt}`, 423)

  const start    = Date.now()
  const label    = `${nowLabel()}_frontend`
  const snapshot = snapshotFrontend(label)
  const DIST_DIR = path.join(FRONTEND_ROOT, 'dist')
  let results    = []
  let success    = false
  let errorMsg   = null

  try {
    const zip     = new AdmZip(req.file.path)
    const entries = zip.getEntries()

    run(`rm -rf ${DIST_DIR}`)
    fs.mkdirSync(DIST_DIR, { recursive: true })

    for (const entry of entries) {
      if (entry.isDirectory) continue
      let name = entry.entryName
      if (name.startsWith('dist/')) name = name.slice(5)
      if (!name || name.includes('..')) continue

      const dest = path.join(DIST_DIR, name)
      if (!dest.startsWith(path.resolve(DIST_DIR))) continue

      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, entry.getData())
      results.push({ file: name, status: 'ok' })
    }

    fs.unlinkSync(req.file.path)
    run(`chown -R www-data:www-data ${DIST_DIR}`)
    run(`chmod -R 755 ${DIST_DIR}`)

    success = true
    return ok(res, {
      results,
      snapshot: label,
      message: `Frontend deployed. ${results.length} file(s) written to dist/.`,
    })
  } catch (e) {
    // Restore previous frontend on failure
    try { restoreFrontend(snapshot) } catch {}
    errorMsg = e.message
    try { fs.unlinkSync(req.file.path) } catch {}
    return fail(res, e.message, 500)
  } finally {
    releaseLock()
    await logDeployment({
      triggered_by:   req.session.userId,
      action_type:    'frontend-zip',
      snapshot_label: label,
      duration_ms:    Date.now() - start,
      success,
      error_message:  errorMsg,
      metadata:       { files: results.length },
    })
  }
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/git-pull
// ─────────────────────────────────────────────────────────────
router.post('/git-pull', ...isAdmin, asyncHandler(async (req, res) => {
  const lock = acquireLock(req.session.userId)
  if (!lock.ok) return fail(res, `Deploy in progress since ${lock.startedAt}`, 423)

  const start    = Date.now()
  const label    = `${nowLabel()}_gitpull`
  const snapshot = snapshotBackend(label)
  let success    = false
  let errorMsg   = null

  try {
    const pull = await runAsync('git pull origin main')
    if (!pull.ok) throw new Error(pull.stderr || 'git pull failed')

    run(`pm2 restart ${PM2_APP_NAME} --update-env`)
    const health = await waitForHealth()

    if (!health.ok) {
      restoreBackend(snapshot)
      run(`pm2 restart ${PM2_APP_NAME} --update-env`)
      throw new Error('Health check failed after git pull — auto-rolled back')
    }

    success = true
    return ok(res, {
      pull_output:  pull.stdout,
      snapshot:     label,
      health_check: health,
      message:      'Git pull successful. Health check passed.',
    })
  } catch (e) {
    errorMsg = e.message
    return fail(res, e.message, 500)
  } finally {
    releaseLock()
    await logDeployment({
      triggered_by:   req.session.userId,
      action_type:    'git-pull',
      snapshot_label: label,
      duration_ms:    Date.now() - start,
      success,
      error_message:  errorMsg,
    })
  }
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/restart
// ─────────────────────────────────────────────────────────────
router.post('/restart', ...isAdmin, asyncHandler(async (req, res) => {
  const lock = acquireLock(req.session.userId)
  if (!lock.ok) return fail(res, `Deploy in progress since ${lock.startedAt}`, 423)

  const start   = Date.now()
  let success   = false
  let errorMsg  = null

  try {
    run(`pm2 restart ${PM2_APP_NAME} --update-env`)
    const health = await waitForHealth()
    if (!health.ok) throw new Error('Server did not come back healthy after restart')

    success = true
    return ok(res, { health_check: health, message: 'Server restarted successfully.' })
  } catch (e) {
    errorMsg = e.message
    return fail(res, e.message, 500)
  } finally {
    releaseLock()
    await logDeployment({
      triggered_by:  req.session.userId,
      action_type:   'restart',
      duration_ms:   Date.now() - start,
      success,
      error_message: errorMsg,
    })
  }
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/rollback/:label
// ─────────────────────────────────────────────────────────────
router.post('/rollback/:label', ...isAdmin, asyncHandler(async (req, res) => {
  const { label } = req.params
  const type      = req.body.type || 'backend' // 'backend' or 'frontend'

  const lock = acquireLock(req.session.userId)
  if (!lock.ok) return fail(res, `Deploy in progress since ${lock.startedAt}`, 423)

  const start   = Date.now()
  let success   = false
  let errorMsg  = null

  try {
    const snapshotPath = path.join(RELEASES_DIR, type, label)
    if (!fs.existsSync(snapshotPath)) {
      return fail(res, `Snapshot "${label}" not found`, 404)
    }

    if (type === 'backend') {
      restoreBackend(snapshotPath)
      run(`pm2 restart ${PM2_APP_NAME} --update-env`)
      const health = await waitForHealth()
      if (!health.ok) throw new Error('Rollback completed but health check failed')
    } else {
      restoreFrontend(snapshotPath)
    }

    success = true
    return ok(res, { message: `Rolled back to ${label} successfully.`, type })
  } catch (e) {
    errorMsg = e.message
    return fail(res, e.message, 500)
  } finally {
    releaseLock()
    await logDeployment({
      triggered_by:   req.session.userId,
      action_type:    'rollback',
      snapshot_label: label,
      duration_ms:    Date.now() - start,
      success,
      error_message:  errorMsg,
      rollback_used:  true,
      metadata:       { type },
    })
  }
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/env
// ─────────────────────────────────────────────────────────────
router.post('/env', ...isAdmin, asyncHandler(async (req, res) => {
  const { updates } = req.body
  if (!updates || typeof updates !== 'object') {
    return fail(res, 'Body must contain { updates: { KEY: value } }', 400)
  }

  const keys    = Object.keys(updates)
  const blocked = keys.filter(k => !ALLOWED_ENV_KEYS.includes(k))
  if (blocked.length) {
    return fail(res, `Keys not in allowlist: ${blocked.join(', ')}`, 403)
  }

  const envPath   = path.join(BACKEND_ROOT, '.env')
  const backupDir = path.join(RELEASES_DIR, 'backend', 'env-backups')
  fs.mkdirSync(backupDir, { recursive: true })

  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''

  // Backup before writing
  const backupPath = path.join(backupDir, `${nowLabel()}.env.bak`)
  fs.writeFileSync(backupPath, envContent)

  // Apply updates
  const changed = []
  for (const [key, value] of Object.entries(updates)) {
    const oldHash = crypto.createHash('sha256').update(
      (envContent.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] || ''
    ).digest('hex').slice(0, 8)

    const line    = `${key}=${value}`
    const pattern = new RegExp(`^${key}=.*$`, 'm')
    envContent = pattern.test(envContent)
      ? envContent.replace(pattern, line)
      : envContent + `\n${line}`

    changed.push({ key, old_hash: oldHash })
  }

  fs.writeFileSync(envPath, envContent)
  run(`pm2 restart ${PM2_APP_NAME} --update-env`)

  await logDeployment({
    triggered_by:  req.session.userId,
    action_type:   'env',
    duration_ms:   0,
    success:       true,
    metadata:      { changed },
  })

  return ok(res, {
    updated: keys,
    backup:  backupPath.replace(BACKEND_ROOT, ''),
    message: `${keys.length} env var(s) updated. Server restarted.`,
  })
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/maintenance
// ─────────────────────────────────────────────────────────────
router.post('/maintenance', ...isAdmin, asyncHandler(async (req, res) => {
  const { enabled } = req.body
  if (typeof enabled !== 'boolean') {
    return fail(res, 'Body must contain { enabled: true|false }', 400)
  }

  const flagFile = '/tmp/inquisia_maintenance'

  if (enabled) {
    fs.writeFileSync(flagFile, '1')
  } else {
    if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile)
  }

  await logDeployment({
    triggered_by: req.session.userId,
    action_type:  'maintenance',
    duration_ms:  0,
    success:      true,
    metadata:     { enabled },
  })

  return ok(res, {
    maintenance: enabled,
    message: enabled ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.',
  })
}))

export default router
