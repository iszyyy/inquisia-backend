/**
 * Inquisia Update System
 * ──────────────────────────────────────────────────────────────
 * Routes:
 *   GET  /api/update/status        — server info, git log, uptime
 *   POST /api/update/files         — upload individual files (multipart)
 *   POST /api/update/zip           — upload a zip, extract to backend
 *   POST /api/update/frontend-zip  — upload a zip, build & deploy frontend
 *   POST /api/update/git-pull      — git pull + restart
 *   POST /api/update/restart       — restart PM2 process
 *   POST /api/update/env           — update .env key-value pairs
 *   GET  /api/update/logs          — tail PM2 logs
 *
 * All routes require admin role.
 */

import { Router }   from 'express'
import { requireRole, requireActive } from '../middleware/auth.js'
import multer        from 'multer'
import { execSync, exec } from 'child_process'
import fs            from 'fs'
import path          from 'path'
import { fileURLToPath } from 'url'
import AdmZip        from 'adm-zip'
import { ok, fail, asyncHandler } from '../lib/response.js'

const router  = Router()
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BACKEND_ROOT = path.resolve(__dirname, '../../')   // /opt/inquisia-backend
const FRONTEND_ROOT = '/var/www/inquisia.iszy.cloud'
const PM2_APP_NAME  = 'inquisia-backend'

// ── Auth guard — all update routes require admin ──────────────
const isAdmin = [...requireRole('admin'), requireActive]

// ── Multer — store in /tmp for update uploads ─────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, '/tmp'),
  filename:    (_req, file, cb)  => cb(null, `update_${Date.now()}_${file.originalname}`),
})

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
})

// ── Helper: run shell command and return output ───────────────
function run(cmd, cwd = BACKEND_ROOT) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 120000 }).trim()
  } catch (e) {
    return e.message || String(e)
  }
}

// ── Helper: async shell with promise ─────────────────────────
function runAsync(cmd, cwd = BACKEND_ROOT) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, encoding: 'utf8', timeout: 180000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err: err?.message })
    })
  })
}

// ── Helper: safe path check (prevent path traversal) ─────────
function safePath(base, relative) {
  const resolved = path.resolve(base, relative)
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error(`Path traversal attempt blocked: ${relative}`)
  }
  return resolved
}

// ─────────────────────────────────────────────────────────────
// GET /api/update/status
// ─────────────────────────────────────────────────────────────
router.get('/status', ...isAdmin, asyncHandler(async (_req, res) => {
  const gitLog    = run('git log --oneline -5')
  const gitBranch = run('git rev-parse --abbrev-ref HEAD')
  const gitStatus = run('git status --short')
  const pm2Status = run(`pm2 jlist`)
  const uptime    = run('uptime -p')
  const diskUsage = run('df -h / | tail -1')
  const memUsage  = run('free -m | grep Mem')
  const nodeVer   = run('node --version')

  let pm2Info = null
  try {
    const list = JSON.parse(pm2Status)
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
  } catch { /* pm2 not available */ }

  return ok(res, {
    git: {
      branch:      gitBranch,
      recent_logs: gitLog.split('\n'),
      dirty_files: gitStatus.split('\n').filter(Boolean),
    },
    pm2: pm2Info,
    system: {
      uptime,
      disk:    diskUsage,
      memory:  memUsage,
      node:    nodeVer,
    },
    backend_root:  BACKEND_ROOT,
    frontend_root: FRONTEND_ROOT,
    timestamp:     new Date().toISOString(),
  })
}))

// ─────────────────────────────────────────────────────────────
// GET /api/update/logs
// ─────────────────────────────────────────────────────────────
router.get('/logs', ...isAdmin, asyncHandler(async (req, res) => {
  const lines = parseInt(req.query.lines) || 50
  const safe  = Math.min(Math.max(lines, 10), 500)
  const out   = run(`pm2 logs ${PM2_APP_NAME} --lines ${safe} --nostream`)
  return ok(res, { logs: out.split('\n') })
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/files
// Upload one or more individual source files directly into the backend.
// Field name: "files" (multiple)
// Also accepts optional field "target_dir" (default: src/routes)
// ─────────────────────────────────────────────────────────────
router.post(
  '/files',
  ...isAdmin,
  upload.array('files', 30),
  asyncHandler(async (req, res) => {
    if (!req.files?.length) return fail(res, 'No files uploaded', 400)

    const targetDir = req.body.target_dir || 'src/routes'
    const results   = []

    for (const file of req.files) {
      try {
        const destDir  = safePath(BACKEND_ROOT, targetDir)
        const destFile = path.join(destDir, file.originalname)

        // Ensure destination directory exists
        fs.mkdirSync(destDir, { recursive: true })

        // Move uploaded file into place
        fs.copyFileSync(file.path, destFile)
        fs.unlinkSync(file.path)

        results.push({ file: file.originalname, status: 'ok', dest: destFile.replace(BACKEND_ROOT, '') })
      } catch (e) {
        results.push({ file: file.originalname, status: 'error', error: e.message })
      }
    }

    const hasErrors = results.some(r => r.status === 'error')

    // Restart backend after file deployment
    const restart = run(`pm2 restart ${PM2_APP_NAME} --update-env`)

    return ok(res, {
      results,
      restart,
      success: !hasErrors,
      message: hasErrors ? 'Some files failed. Check results.' : `${results.length} file(s) deployed and server restarted.`,
    })
  })
)

// ─────────────────────────────────────────────────────────────
// POST /api/update/zip
// Upload a zip of backend source files. The zip should contain
// files relative to /opt/inquisia-backend/ (e.g. src/routes/auth.js)
// ─────────────────────────────────────────────────────────────
router.post(
  '/zip',
  ...isAdmin,
  upload.single('zip'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'No zip file uploaded', 400)
    if (!req.file.originalname.endsWith('.zip')) return fail(res, 'File must be a .zip', 400)

    const results = []
    let extracted = 0

    try {
      const zip     = new AdmZip(req.file.path)
      const entries = zip.getEntries()

      for (const entry of entries) {
        if (entry.isDirectory) continue

        const entryName = entry.entryName

        // Security: block dangerous paths
        if (entryName.includes('..') || entryName.startsWith('/')) {
          results.push({ file: entryName, status: 'skipped', reason: 'unsafe path' })
          continue
        }

        // Only allow JS/JSON/SQL/env files — not node_modules, .git, etc.
        const allowed = ['.js', '.json', '.sql', '.env', '.md', '.cjs', '.mjs']
        const ext     = path.extname(entryName).toLowerCase()
        if (!allowed.includes(ext) && !entryName.includes('.env')) {
          results.push({ file: entryName, status: 'skipped', reason: 'file type not allowed' })
          continue
        }

        // Block overwriting .env unless explicitly allowed
        if (entryName === '.env' && req.body.allow_env !== 'true') {
          results.push({ file: entryName, status: 'skipped', reason: '.env update requires allow_env=true' })
          continue
        }

        try {
          const destPath = safePath(BACKEND_ROOT, entryName)
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          zip.extractEntryTo(entry, path.dirname(destPath), false, true)
          extracted++
          results.push({ file: entryName, status: 'ok' })
        } catch (e) {
          results.push({ file: entryName, status: 'error', error: e.message })
        }
      }

      fs.unlinkSync(req.file.path)
    } catch (e) {
      return fail(res, `Failed to process zip: ${e.message}`, 500)
    }

    // Restart after extraction
    const restart = run(`pm2 restart ${PM2_APP_NAME} --update-env`)

    return ok(res, {
      extracted,
      results,
      restart,
      message: `${extracted} file(s) extracted and server restarted.`,
    })
  })
)

// ─────────────────────────────────────────────────────────────
// POST /api/update/frontend-zip
// Upload a zip of the frontend dist/ build. Extracts into
// /var/www/inquisia.iszy.cloud/dist/ and fixes permissions.
// ─────────────────────────────────────────────────────────────
router.post(
  '/frontend-zip',
  ...isAdmin,
  upload.single('zip'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'No zip file uploaded', 400)
    if (!req.file.originalname.endsWith('.zip')) return fail(res, 'File must be a .zip', 400)

    const DIST_DIR = path.join(FRONTEND_ROOT, 'dist')
    let extracted  = 0
    const results  = []

    try {
      const zip     = new AdmZip(req.file.path)
      const entries = zip.getEntries()

      // Clear existing dist
      run(`rm -rf ${DIST_DIR}`)
      fs.mkdirSync(DIST_DIR, { recursive: true })

      for (const entry of entries) {
        if (entry.isDirectory) continue

        let entryName = entry.entryName

        // Strip leading "dist/" if zipped with that prefix
        if (entryName.startsWith('dist/')) entryName = entryName.slice(5)

        if (entryName.includes('..') || !entryName) continue

        try {
          const destPath = path.join(DIST_DIR, entryName)
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, entry.getData())
          extracted++
          results.push({ file: entryName, status: 'ok' })
        } catch (e) {
          results.push({ file: entryName, status: 'error', error: e.message })
        }
      }

      fs.unlinkSync(req.file.path)
    } catch (e) {
      return fail(res, `Failed to process frontend zip: ${e.message}`, 500)
    }

    // Fix permissions
    run(`chown -R www-data:www-data ${DIST_DIR}`)
    run(`chmod -R 755 ${DIST_DIR}`)

    return ok(res, {
      extracted,
      results,
      message: `Frontend deployed. ${extracted} file(s) written to dist/.`,
    })
  })
)

// ─────────────────────────────────────────────────────────────
// POST /api/update/git-pull
// Pull latest from git remote and restart
// ─────────────────────────────────────────────────────────────
router.post('/git-pull', ...isAdmin, asyncHandler(async (req, res) => {
  const pull    = await runAsync(`git pull origin main`, BACKEND_ROOT)
  const restart = run(`pm2 restart ${PM2_APP_NAME} --update-env`)

  return ok(res, {
    pull_output:    pull.stdout || pull.stderr,
    restart_output: restart,
    success:        pull.ok,
    message:        pull.ok ? 'Git pull successful. Server restarted.' : 'Git pull had issues. Check output.',
  })
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/restart
// Restart PM2 process only
// ─────────────────────────────────────────────────────────────
router.post('/restart', ...isAdmin, asyncHandler(async (_req, res) => {
  const output = run(`pm2 restart ${PM2_APP_NAME} --update-env`)
  return ok(res, { output, message: 'Server restart initiated.' })
}))

// ─────────────────────────────────────────────────────────────
// POST /api/update/env
// Update individual .env key=value pairs (never replaces whole file)
// Body: { updates: { KEY: "value", KEY2: "value2" } }
// ─────────────────────────────────────────────────────────────
router.post('/env', ...isAdmin, asyncHandler(async (req, res) => {
  const { updates } = req.body
  if (!updates || typeof updates !== 'object') {
    return fail(res, 'Body must contain { updates: { KEY: value } }', 400)
  }

  // Blocked keys — cannot be changed via API
  const BLOCKED = ['SESSION_SECRET', 'DATABASE_URL']
  const keys    = Object.keys(updates)
  const blocked = keys.filter(k => BLOCKED.includes(k))
  if (blocked.length) {
    return fail(res, `Cannot update protected keys: ${blocked.join(', ')}`, 403)
  }

  const envPath = path.join(BACKEND_ROOT, '.env')
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''

  for (const [key, value] of Object.entries(updates)) {
    const line    = `${key}=${value}`
    const pattern = new RegExp(`^${key}=.*$`, 'm')
    if (pattern.test(envContent)) {
      envContent = envContent.replace(pattern, line)
    } else {
      envContent += `\n${line}`
    }
  }

  fs.writeFileSync(envPath, envContent)

  // Restart to apply new env
  const restart = run(`pm2 restart ${PM2_APP_NAME} --update-env`)

  return ok(res, {
    updated: keys,
    restart,
    message: `${keys.length} env var(s) updated. Server restarted.`,
  })
}))

export default router
