import { Router } from 'express'
import { query } from '../lib/db.js'
import { ok, asyncHandler } from '../lib/response.js'

const router = Router()

// ── GET /api/public/stats ─────────────────────────────────────

router.get('/public/stats', asyncHandler(async (_req, res) => {
  const [[projects], [students], [supervisors], [downloads]] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM projects WHERE status = 'approved'`),
    query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'student'`),
    query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'supervisor' AND is_verified = true`),
    query(`SELECT COALESCE(SUM(download_count), 0)::int AS n FROM projects WHERE status = 'approved'`),
  ])
  return ok(res, {
    total_projects:    projects.n,
    total_students:    students.n,
    total_supervisors: supervisors.n,
    total_downloads:   downloads.n,
  })
}))

// ── GET /api/departments ──────────────────────────────────────

router.get('/departments', asyncHandler(async (_req, res) => {
  const rows = await query('SELECT id, name FROM departments ORDER BY name')
  return ok(res, rows)
}))

// ── GET /api/ai-categories ────────────────────────────────────

router.get('/ai-categories', asyncHandler(async (_req, res) => {
  const rows = await query('SELECT name FROM ai_categories ORDER BY name')
  return ok(res, rows)
}))

// ── GET /api/supervisors ──────────────────────────────────────
// Optional query: ?department_id=<uuid>

router.get('/supervisors', asyncHandler(async (req, res) => {
  const { department_id } = req.query
  let rows

  if (department_id) {
    rows = await query(
      `SELECT u.id, u.full_name, u.display_name, u.degrees,
              ARRAY_AGG(d.name) FILTER (WHERE d.name IS NOT NULL) AS departments
       FROM users u
       LEFT JOIN supervisor_departments sd ON sd.supervisor_id = u.id
       LEFT JOIN departments d ON d.id = sd.department_id
       WHERE u.role = 'supervisor'
         AND u.is_verified = true
         AND u.account_status = 'active'
         AND sd.department_id = $1
       GROUP BY u.id
       ORDER BY u.full_name`,
      [department_id]
    )
  } else {
    rows = await query(
      `SELECT u.id, u.full_name, u.display_name, u.degrees,
              ARRAY_AGG(d.name) FILTER (WHERE d.name IS NOT NULL) AS departments
       FROM users u
       LEFT JOIN supervisor_departments sd ON sd.supervisor_id = u.id
       LEFT JOIN departments d ON d.id = sd.department_id
       WHERE u.role = 'supervisor'
         AND u.is_verified = true
         AND u.account_status = 'active'
       GROUP BY u.id
       ORDER BY u.full_name`
    )
  }

  return ok(res, rows.map((r) => ({
    id:           r.id,
    full_name:    r.full_name,
    display_name: r.display_name,
    degrees:      r.degrees,
    departments:  r.departments || [],
  })))
}))

export default router
