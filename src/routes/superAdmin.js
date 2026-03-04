/**
 * Inquisia Super Admin Routes
 * ─────────────────────────────────────────────────────────────
 * All routes require is_super_admin = true.
 *
 * Modules:
 *   GET  /api/super/users                     — all users inc. admins
 *   PATCH /api/super/users/:id/role           — change any user's role
 *   PATCH /api/super/users/:id/super          — grant/revoke super admin
 *   DELETE /api/super/users/:id               — hard delete user
 *   GET  /api/super/users/:id/activity        — user activity log
 *
 *   GET  /api/super/projects                  — all projects all statuses
 *   DELETE /api/super/projects/:id            — hard delete any project
 *   PATCH /api/super/projects/:id/force-status — override project status
 *
 *   GET  /api/super/ai/usage                  — AI usage stats
 *
 *   GET  /api/super/audit/log                 — full audit log
 *   POST /api/super/audit/purge-sessions      — kill all sessions (emergency)
 *
 *   GET  /api/super/settings                  — all system settings
 *   PATCH /api/super/settings/:key            — update a setting
 *
 *   GET  /api/super/flags                     — all feature flags
 *   PATCH /api/super/flags/:key               — toggle feature flag
 *
 *   GET  /api/super/analytics/overview        — platform growth metrics
 *   GET  /api/super/analytics/departments     — per-department breakdown
 *
 *   GET  /api/super/monitor/health            — full system health
 */

import { Router }   from 'express'
import { z }        from 'zod'
import { execSync } from 'child_process'
import { query, transaction } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireSuperAdmin, requireActive, auditLog } from '../middleware/auth.js'

const router = Router()

// ── Super admin guard on ALL routes in this file ──────────────
router.use(requireSuperAdmin, requireActive)

// ── Shell helper ──────────────────────────────────────────────
function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim() }
  catch (e) { return e.message }
}

// ─────────────────────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /api/super/users
router.get('/users', asyncHandler(async (req, res) => {
  const { query: q, role, status, page = '1', limit = '50' } = req.query
  const pageNum  = Math.max(1, parseInt(page) || 1)
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50))
  const offset   = (pageNum - 1) * limitNum

  const conditions = []
  const params = []
  let i = 1

  if (q) {
    conditions.push(`(u.email ILIKE $${i} OR u.full_name ILIKE $${i} OR u.matric_no ILIKE $${i})`)
    params.push(`%${q}%`)
    i++
  }
  if (role) { conditions.push(`u.role = $${i}`); params.push(role); i++ }
  if (status) { conditions.push(`u.account_status = $${i}`); params.push(status); i++ }

  const WHERE = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [{ count }] = await query(`SELECT COUNT(*) FROM users u ${WHERE}`, params)

  const rows = await query(
    `SELECT u.*,
       (SELECT COUNT(*) FROM project_authors pa WHERE pa.user_id = u.id) AS project_count,
       (SELECT COUNT(*) FROM admin_audit_log al WHERE al.actor_id = u.id) AS audit_count
     FROM users u
     ${WHERE}
     ORDER BY u.created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limitNum, offset]
  )

  return ok(res, {
    items: rows,
    total: parseInt(count),
    page: pageNum,
    limit: limitNum,
    total_pages: Math.ceil(parseInt(count) / limitNum),
  })
}))

// PATCH /api/super/users/:id/role
router.patch('/users/:id/role', asyncHandler(async (req, res) => {
  const { id } = req.params

  // Cannot modify self
  if (id === req.session.userId) return fail(res, 'Cannot modify your own role', 400)

  const schema = z.object({ role: z.enum(['student', 'supervisor', 'admin', 'public']) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Invalid role', 400)

  const [before] = await query('SELECT id, role, email FROM users WHERE id=$1', [id])
  if (!before) return fail(res, 'User not found', 404)

  // Cannot demote another super admin
  const [target] = await query('SELECT is_super_admin FROM users WHERE id=$1', [id])
  if (target.is_super_admin) return fail(res, 'Cannot change role of a super admin', 403)

  const [after] = await query(
    'UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [parsed.data.role, id]
  )

  await auditLog({
    req,
    action:     'user.role_changed',
    targetType: 'user',
    targetId:   id,
    before:     { role: before.role },
    after:      { role: parsed.data.role },
  })

  return ok(res, after)
}))

// PATCH /api/super/users/:id/super
router.patch('/users/:id/super', asyncHandler(async (req, res) => {
  const { id } = req.params
  if (id === req.session.userId) return fail(res, 'Cannot modify your own super admin status', 400)

  const schema = z.object({ is_super_admin: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Body must contain { is_super_admin: boolean }', 400)

  const [before] = await query('SELECT id, email, is_super_admin FROM users WHERE id=$1', [id])
  if (!before) return fail(res, 'User not found', 404)

  const [after] = await query(
    'UPDATE users SET is_super_admin=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [parsed.data.is_super_admin, id]
  )

  await auditLog({
    req,
    action:     parsed.data.is_super_admin ? 'user.super_admin_granted' : 'user.super_admin_revoked',
    targetType: 'user',
    targetId:   id,
    before:     { is_super_admin: before.is_super_admin },
    after:      { is_super_admin: parsed.data.is_super_admin },
  })

  return ok(res, after)
}))

// DELETE /api/super/users/:id
router.delete('/users/:id', asyncHandler(async (req, res) => {
  const { id } = req.params
  if (id === req.session.userId) return fail(res, 'Cannot delete your own account', 400)

  const [user] = await query('SELECT id, email, role, is_super_admin FROM users WHERE id=$1', [id])
  if (!user) return fail(res, 'User not found', 404)
  if (user.is_super_admin) return fail(res, 'Cannot delete a super admin account', 403)

  await query('DELETE FROM users WHERE id=$1', [id])

  await auditLog({
    req,
    action:     'user.hard_deleted',
    targetType: 'user',
    targetId:   id,
    before:     { email: user.email, role: user.role },
  })

  return ok(res, null)
}))

// GET /api/super/users/:id/activity
router.get('/users/:id/activity', asyncHandler(async (req, res) => {
  const { id } = req.params
  const [user] = await query('SELECT id, email, full_name FROM users WHERE id=$1', [id])
  if (!user) return fail(res, 'User not found', 404)

  const [auditEntries, projects, aiUsage] = await Promise.all([
    query(
      `SELECT * FROM admin_audit_log WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [id]
    ),
    query(
      `SELECT p.id, p.title, p.status, p.created_at
       FROM projects p
       JOIN project_authors pa ON pa.project_id = p.id
       WHERE pa.user_id=$1
       ORDER BY p.created_at DESC LIMIT 10`,
      [id]
    ),
    query(
      `SELECT action, COUNT(*) as count
       FROM ai_usage_log WHERE user_id=$1
       GROUP BY action`,
      [id]
    ),
  ])

  return ok(res, { user, audit: auditEntries, projects, ai_usage: aiUsage })
}))

// ─────────────────────────────────────────────────────────────
// GLOBAL PROJECT CONTROL
// ─────────────────────────────────────────────────────────────

// GET /api/super/projects
router.get('/projects', asyncHandler(async (req, res) => {
  const { query: q, status, department_id, page = '1', limit = '20' } = req.query
  const pageNum  = Math.max(1, parseInt(page) || 1)
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20))
  const offset   = (pageNum - 1) * limitNum

  const conditions = []
  const params = []
  let i = 1

  if (q) {
    conditions.push(`(p.title ILIKE $${i} OR p.abstract ILIKE $${i})`)
    params.push(`%${q}%`)
    i++
  }
  if (status) { conditions.push(`p.status = $${i}`); params.push(status); i++ }
  if (department_id) { conditions.push(`p.department_id = $${i}`); params.push(department_id); i++ }

  const WHERE = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [{ count }] = await query(`SELECT COUNT(*) FROM projects p ${WHERE}`, params)

  const rows = await query(
    `SELECT p.*, d.name AS department_name,
       sv.full_name AS supervisor_name,
       (SELECT full_name FROM users u
        JOIN project_authors pa ON pa.user_id = u.id
        WHERE pa.project_id = p.id AND pa.is_lead = true LIMIT 1) AS lead_author
     FROM projects p
     LEFT JOIN departments d ON d.id = p.department_id
     LEFT JOIN users sv ON sv.id = p.supervisor_id
     ${WHERE}
     ORDER BY p.created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limitNum, offset]
  )

  return ok(res, {
    items: rows,
    total: parseInt(count),
    page: pageNum,
    limit: limitNum,
    total_pages: Math.ceil(parseInt(count) / limitNum),
  })
}))

// DELETE /api/super/projects/:id  (hard delete, even approved)
router.delete('/projects/:id', asyncHandler(async (req, res) => {
  const [project] = await query('SELECT id, title, status FROM projects WHERE id=$1', [req.params.id])
  if (!project) return fail(res, 'Project not found', 404)

  await query('DELETE FROM projects WHERE id=$1', [req.params.id])

  await auditLog({
    req,
    action:     'project.hard_deleted',
    targetType: 'project',
    targetId:   req.params.id,
    before:     { title: project.title, status: project.status },
  })

  return ok(res, null)
}))

// PATCH /api/super/projects/:id/force-status
router.patch('/projects/:id/force-status', asyncHandler(async (req, res) => {
  const schema = z.object({
    status: z.enum(['pending', 'approved', 'changes_requested', 'rejected']),
    reason: z.string().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Invalid status', 400)

  const [before] = await query('SELECT id, title, status FROM projects WHERE id=$1', [req.params.id])
  if (!before) return fail(res, 'Project not found', 404)

  const approved_at = parsed.data.status === 'approved' ? 'NOW()' : 'approved_at'

  const [after] = await query(
    `UPDATE projects SET status=$1, updated_at=NOW(), approved_at=${approved_at} WHERE id=$2 RETURNING *`,
    [parsed.data.status, req.params.id]
  )

  await auditLog({
    req,
    action:     'project.status_forced',
    targetType: 'project',
    targetId:   req.params.id,
    before:     { status: before.status },
    after:      { status: parsed.data.status, reason: parsed.data.reason },
  })

  return ok(res, after)
}))

// ─────────────────────────────────────────────────────────────
// AI CONTROL CENTER
// ─────────────────────────────────────────────────────────────

// GET /api/super/ai/usage
router.get('/ai/usage', asyncHandler(async (_req, res) => {
  const [byAction, byDay, topUsers] = await Promise.all([
    query(`SELECT action, COUNT(*) AS count FROM ai_usage_log GROUP BY action ORDER BY count DESC`),
    query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS calls
      FROM ai_usage_log
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day DESC
    `),
    query(`
      SELECT u.id, u.email, u.full_name, COUNT(*) AS ai_calls
      FROM ai_usage_log al
      JOIN users u ON u.id = al.user_id
      GROUP BY u.id, u.email, u.full_name
      ORDER BY ai_calls DESC
      LIMIT 20
    `),
  ])

  return ok(res, { by_action: byAction, by_day: byDay, top_users: topUsers })
}))

// ─────────────────────────────────────────────────────────────
// SECURITY & AUDIT
// ─────────────────────────────────────────────────────────────

// GET /api/super/audit/log
router.get('/audit/log', asyncHandler(async (req, res) => {
  const { action, target_type, actor_id, page = '1', limit = '50' } = req.query
  const pageNum  = Math.max(1, parseInt(page) || 1)
  const limitNum = Math.min(200, parseInt(limit) || 50)
  const offset   = (pageNum - 1) * limitNum

  const conditions = []
  const params = []
  let i = 1

  if (action)      { conditions.push(`al.action ILIKE $${i}`);      params.push(`%${action}%`);  i++ }
  if (target_type) { conditions.push(`al.target_type = $${i}`);     params.push(target_type);    i++ }
  if (actor_id)    { conditions.push(`al.actor_id = $${i}`);        params.push(actor_id);       i++ }

  const WHERE = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = await query(
    `SELECT al.*, u.email AS actor_email, u.full_name AS actor_name
     FROM admin_audit_log al
     LEFT JOIN users u ON u.id = al.actor_id
     ${WHERE}
     ORDER BY al.created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limitNum, offset]
  )

  return ok(res, rows)
}))

// POST /api/super/audit/purge-sessions  (nuclear option)
router.post('/audit/purge-sessions', asyncHandler(async (req, res) => {
  // Flush all Redis session keys
  run(`redis-cli -u ${process.env.REDIS_URL || 'redis://127.0.0.1:6379'} FLUSHDB`)

  await auditLog({
    req,
    action: 'security.all_sessions_purged',
    targetType: 'system',
  })

  return ok(res, { message: 'All sessions purged. All users have been logged out.' })
}))

// ─────────────────────────────────────────────────────────────
// SYSTEM SETTINGS
// ─────────────────────────────────────────────────────────────

// GET /api/super/settings
router.get('/settings', asyncHandler(async (_req, res) => {
  const rows = await query('SELECT * FROM system_settings ORDER BY key')
  return ok(res, rows)
}))

// PATCH /api/super/settings/:key
router.patch('/settings/:key', asyncHandler(async (req, res) => {
  const { key } = req.params
  const { value } = req.body
  if (value === undefined) return fail(res, 'value is required', 400)

  const [existing] = await query('SELECT * FROM system_settings WHERE key=$1', [key])
  if (!existing) return fail(res, `Setting "${key}" not found`, 404)

  const [updated] = await query(
    `UPDATE system_settings SET value=$1, updated_by=$2, updated_at=NOW() WHERE key=$3 RETURNING *`,
    [JSON.stringify(value), req.session.userId, key]
  )

  await auditLog({
    req,
    action:     'setting.updated',
    targetType: 'setting',
    targetId:   key,
    before:     { value: existing.value },
    after:      { value },
  })

  return ok(res, updated)
}))

// ─────────────────────────────────────────────────────────────
// FEATURE FLAGS
// ─────────────────────────────────────────────────────────────

// GET /api/super/flags
router.get('/flags', asyncHandler(async (_req, res) => {
  const rows = await query('SELECT * FROM feature_flags ORDER BY key')
  return ok(res, rows)
}))

// PATCH /api/super/flags/:key
router.patch('/flags/:key', asyncHandler(async (req, res) => {
  const { key } = req.params
  const schema = z.object({ enabled: z.boolean() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Body must contain { enabled: boolean }', 400)

  const [existing] = await query('SELECT * FROM feature_flags WHERE key=$1', [key])
  if (!existing) return fail(res, `Flag "${key}" not found`, 404)

  const [updated] = await query(
    `UPDATE feature_flags SET enabled=$1, updated_by=$2, updated_at=NOW() WHERE key=$3 RETURNING *`,
    [parsed.data.enabled, req.session.userId, key]
  )

  await auditLog({
    req,
    action:     parsed.data.enabled ? 'flag.enabled' : 'flag.disabled',
    targetType: 'feature_flag',
    targetId:   key,
    before:     { enabled: existing.enabled },
    after:      { enabled: parsed.data.enabled },
  })

  return ok(res, updated)
}))

// ─────────────────────────────────────────────────────────────
// PLATFORM ANALYTICS
// ─────────────────────────────────────────────────────────────

// GET /api/super/analytics/overview
router.get('/analytics/overview', asyncHandler(async (_req, res) => {
  const [users, projects, downloads, registrationsByDay, uploadsByDay] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE role='student')    AS students,
        COUNT(*) FILTER (WHERE role='supervisor') AS supervisors,
        COUNT(*) FILTER (WHERE role='admin')      AS admins,
        COUNT(*) FILTER (WHERE account_status='banned') AS banned,
        COUNT(*) AS total
      FROM users
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE status='approved')          AS approved,
        COUNT(*) FILTER (WHERE status='pending')           AS pending,
        COUNT(*) FILTER (WHERE status='changes_requested') AS changes_requested,
        COUNT(*) FILTER (WHERE status='rejected')          AS rejected,
        COUNT(*) AS total
      FROM projects
    `),
    query(`SELECT COALESCE(SUM(download_count), 0) AS total FROM projects`),
    query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS count
      FROM users
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day
    `),
    query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS count
      FROM projects
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day
    `),
  ])

  return ok(res, {
    users:                 users[0],
    projects:              projects[0],
    total_downloads:       parseInt(downloads[0].total),
    registrations_by_day:  registrationsByDay,
    uploads_by_day:        uploadsByDay,
  })
}))

// GET /api/super/analytics/departments
router.get('/analytics/departments', asyncHandler(async (_req, res) => {
  const rows = await query(`
    SELECT
      d.id,
      d.name,
      COUNT(DISTINCT p.id) FILTER (WHERE p.status='approved') AS approved_projects,
      COUNT(DISTINCT p.id) AS total_projects,
      COUNT(DISTINCT pa.user_id) AS total_students,
      COALESCE(SUM(p.download_count), 0) AS total_downloads
    FROM departments d
    LEFT JOIN projects p    ON p.department_id = d.id
    LEFT JOIN project_authors pa ON pa.project_id = p.id AND pa.is_lead = true
    GROUP BY d.id, d.name
    ORDER BY total_projects DESC
  `)
  return ok(res, rows)
}))

// ─────────────────────────────────────────────────────────────
// MONITORING
// ─────────────────────────────────────────────────────────────

// GET /api/super/monitor/health
router.get('/monitor/health', asyncHandler(async (_req, res) => {
  // DB check
  let dbOk = false
  let dbLatency = null
  try {
    const start = Date.now()
    await query('SELECT 1')
    dbLatency = Date.now() - start
    dbOk = true
  } catch {}

  // Redis check
  let redisOk = false
  try {
    const result = run(`redis-cli -u ${process.env.REDIS_URL || 'redis://127.0.0.1:6379'} PING`)
    redisOk = result.trim() === 'PONG'
  } catch {}

  // System stats
  const disk   = run('df -h / | tail -1')
  const mem    = run('free -m | grep Mem')
  const uptime = run('uptime -p')
  const load   = run('cat /proc/loadavg')

  return ok(res, {
    status:    dbOk && redisOk ? 'healthy' : 'degraded',
    database:  { ok: dbOk, latency_ms: dbLatency },
    redis:     { ok: redisOk },
    system:    { disk, memory: mem, uptime, load },
    timestamp: new Date().toISOString(),
  })
}))

export default router
