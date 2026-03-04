import { Router } from 'express'
import { z } from 'zod'
import { query } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireRole, requireActive } from '../middleware/auth.js'

const router = Router()

const isAdmin = [requireRole('admin'), requireActive]

function serializeUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    full_name: row.full_name ?? null,
    display_name: row.display_name ?? null,
    bio: row.bio ?? null,
    links: row.links ?? [],
    matric_no: row.matric_no ?? null,
    staff_id: row.staff_id ?? null,
    degrees: row.degrees ?? null,
    level: row.level ?? null,
    department_id: row.department_id ?? null,
    is_verified: row.is_verified,
    is_active: row.is_active,
    account_status: row.account_status,
    status_reason: row.status_reason ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    project_count: parseInt(row.project_count ?? 0),
  }
}

const PROJECT_SELECT = `
  SELECT
    p.*,
    d.name AS department_name,
    sv.full_name AS supervisor_name,
    sv.degrees AS supervisor_degrees,
    COALESCE(
      json_agg(
        json_build_object(
          'id', u.id,
          'full_name', u.full_name,
          'display_name', u.display_name,
          'matric_no', u.matric_no,
          'role_description', pa.role_description
        ) ORDER BY pa.is_lead DESC, u.full_name
      ) FILTER (WHERE u.id IS NOT NULL),
      '[]'
    ) AS authors
  FROM projects p
  LEFT JOIN departments d ON d.id = p.department_id
  LEFT JOIN users sv ON sv.id = p.supervisor_id
  LEFT JOIN project_authors pa ON pa.project_id = p.id
  LEFT JOIN users u ON u.id = pa.user_id
`

function serializeProject(row) {
  return {
    id: row.id,
    title: row.title,
    abstract: row.abstract,
    pdf_text: row.pdf_text ?? null,
    student_tags: row.student_tags ?? [],
    ai_tags: row.ai_tags ?? [],
    ai_category: row.ai_category ?? null,
    department_id: row.department_id ?? null,
    department_name: row.department_name ?? null,
    year: row.year,
    status: row.status,
    plagiarism_score: row.plagiarism_score ?? null,
    similar_project_id: row.similar_project_id ?? null,
    similarity_reason: row.similarity_reason ?? null,
    github_url: row.github_url ?? null,
    live_url: row.live_url ?? null,
    report_url: row.report_url ?? null,
    download_count: row.download_count ?? 0,
    supervisor_id: row.supervisor_id ?? null,
    supervisor_name: row.supervisor_name ?? null,
    supervisor_degrees: row.supervisor_degrees ?? null,
    authors: row.authors ?? [],
    ai_summary: row.ai_summary ?? null,
    ai_analysis: row.ai_analysis ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at ?? null,
  }
}

// ── GET /api/admin/users ──────────────────────────────────────────────────
router.get('/users', ...isAdmin, asyncHandler(async (req, res) => {
  const { query: q, role, status } = req.query

  const conditions = []
  const params = []
  let i = 1

  if (q) {
    conditions.push(`(u.full_name ILIKE $${i} OR u.email ILIKE $${i} OR u.matric_no ILIKE $${i})`)
    params.push(`%${q}%`)
    i++
  }
  if (role) {
    conditions.push(`u.role = $${i}`)
    params.push(role)
    i++
  }
  if (status) {
    conditions.push(`u.account_status = $${i}`)
    params.push(status)
    i++
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = await query(
    `SELECT u.*,
       (SELECT COUNT(*) FROM project_authors pa WHERE pa.user_id = u.id)::int AS project_count
     FROM users u
     ${WHERE}
     ORDER BY u.created_at DESC
     LIMIT 200`,
    params
  )

  return ok(res, rows.map(serializeUser))
}))

// ── PATCH /api/admin/users/:id/status ────────────────────────────────────
router.patch('/users/:id/status', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({
    status: z.enum(['active', 'warned', 'restricted', 'banned']),
    reason: z.string().min(1),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [user] = await query(`SELECT id FROM users WHERE id=$1`, [req.params.id])
  if (!user) return fail(res, 'User not found', 404)

  await query(
    `UPDATE users SET account_status=$1, status_reason=$2, updated_at=NOW() WHERE id=$3`,
    [parsed.data.status, parsed.data.reason, req.params.id]
  )

  const [updated] = await query(
    `SELECT u.*,
       (SELECT COUNT(*) FROM project_authors pa WHERE pa.user_id = u.id)::int AS project_count
     FROM users u WHERE u.id=$1`,
    [req.params.id]
  )
  return ok(res, serializeUser(updated))
}))

// ── PATCH /api/admin/users/:id/verify — verify a supervisor ──────────────
router.patch('/users/:id/verify', ...isAdmin, asyncHandler(async (req, res) => {
  const [user] = await query(`SELECT id, role FROM users WHERE id=$1`, [req.params.id])
  if (!user) return fail(res, 'User not found', 404)
  if (user.role !== 'supervisor') return fail(res, 'Only supervisors can be verified', 400)

  await query(
    `UPDATE users SET is_verified=true, updated_at=NOW() WHERE id=$1`,
    [req.params.id]
  )

  const [updated] = await query(
    `SELECT u.*,
       (SELECT COUNT(*) FROM project_authors pa WHERE pa.user_id = u.id)::int AS project_count
     FROM users u WHERE u.id=$1`,
    [req.params.id]
  )
  return ok(res, serializeUser(updated))
}))

// ── GET /api/admin/projects ───────────────────────────────────────────────
router.get('/projects', ...isAdmin, asyncHandler(async (req, res) => {
  const { query: q, status, department_id } = req.query

  const conditions = []
  const params = []
  let i = 1

  if (q) {
    conditions.push(`(p.title ILIKE $${i} OR p.abstract ILIKE $${i})`)
    params.push(`%${q}%`)
    i++
  }
  if (status) {
    conditions.push(`p.status = $${i}`)
    params.push(status)
    i++
  }
  if (department_id) {
    conditions.push(`p.department_id = $${i}`)
    params.push(department_id)
    i++
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = await query(
    `${PROJECT_SELECT}
     ${WHERE}
     GROUP BY p.id, d.name, sv.full_name, sv.degrees
     ORDER BY p.updated_at DESC
     LIMIT 200`,
    params
  )

  return ok(res, rows.map(serializeProject))
}))

// ── PATCH /api/admin/projects/:id/status — admin force approve/reject ────
router.patch('/projects/:id/status', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({
    status: z.enum(['approved', 'rejected', 'pending', 'changes_requested']),
    reason: z.string().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [project] = await query(`SELECT id FROM projects WHERE id=$1`, [req.params.id])
  if (!project) return fail(res, 'Project not found', 404)

  const approved_at = parsed.data.status === 'approved' ? 'NOW()' : 'approved_at'

  await query(
    `UPDATE projects SET status=$1, updated_at=NOW(), approved_at=${approved_at} WHERE id=$2`,
    [parsed.data.status, req.params.id]
  )

  // Notify lead author if reason provided
  if (parsed.data.reason) {
    const [lead] = await query(
      `SELECT user_id FROM project_authors WHERE project_id=$1 AND is_lead=true LIMIT 1`,
      [req.params.id]
    )
    if (lead) {
      const typeMap = {
        approved:          'project_approved',
        rejected:          'project_rejected',
        changes_requested: 'changes_requested',
        pending:           'changes_requested',
      }
      await query(
        `INSERT INTO notifications (user_id, type, title, message, link)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          lead.user_id,
          typeMap[parsed.data.status],
          `Project status updated to ${parsed.data.status}`,
          parsed.data.reason,
          `/projects/${req.params.id}`,
        ]
      )
    }
  }

  const rows = await query(
    `${PROJECT_SELECT} WHERE p.id=$1 GROUP BY p.id, d.name, sv.full_name, sv.degrees`,
    [req.params.id]
  )
  return ok(res, serializeProject(rows[0]))
}))

// ── GET /api/admin/departments ────────────────────────────────────────────
router.get('/departments', ...isAdmin, asyncHandler(async (req, res) => {
  const rows = await query(`SELECT * FROM departments ORDER BY name`)
  return ok(res, rows)
}))

// ── POST /api/admin/departments ───────────────────────────────────────────
router.post('/departments', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ name: z.string().min(2).max(100) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [existing] = await query(`SELECT id FROM departments WHERE name ILIKE $1`, [parsed.data.name])
  if (existing) return fail(res, 'Department already exists', 409)

  const [dept] = await query(
    `INSERT INTO departments (name) VALUES ($1) RETURNING *`,
    [parsed.data.name]
  )
  return ok(res, dept, 201)
}))

// ── PUT /api/admin/departments/:id ────────────────────────────────────────
router.put('/departments/:id', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ name: z.string().min(2).max(100) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [dept] = await query(`SELECT id FROM departments WHERE id=$1`, [req.params.id])
  if (!dept) return fail(res, 'Department not found', 404)

  const [updated] = await query(
    `UPDATE departments SET name=$1 WHERE id=$2 RETURNING *`,
    [parsed.data.name, req.params.id]
  )
  return ok(res, updated)
}))

// ── DELETE /api/admin/departments/:id ─────────────────────────────────────
router.delete('/departments/:id', ...isAdmin, asyncHandler(async (req, res) => {
  const [dept] = await query(`SELECT id FROM departments WHERE id=$1`, [req.params.id])
  if (!dept) return fail(res, 'Department not found', 404)

  const [inUse] = await query(
    `SELECT id FROM projects WHERE department_id=$1 LIMIT 1`,
    [req.params.id]
  )
  if (inUse) return fail(res, 'Cannot delete department with existing projects', 400)

  await query(`DELETE FROM departments WHERE id=$1`, [req.params.id])
  return ok(res, null)
}))

// ── GET /api/admin/ai-categories ─────────────────────────────────────────
router.get('/ai-categories', ...isAdmin, asyncHandler(async (req, res) => {
  const rows = await query(`SELECT * FROM ai_categories ORDER BY name`)
  return ok(res, rows)
}))

// ── POST /api/admin/ai-categories ────────────────────────────────────────
router.post('/ai-categories', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ name: z.string().min(2).max(100) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [existing] = await query(`SELECT name FROM ai_categories WHERE name ILIKE $1`, [parsed.data.name])
  if (existing) return fail(res, 'Category already exists', 409)

  const [cat] = await query(
    `INSERT INTO ai_categories (name) VALUES ($1) RETURNING *`,
    [parsed.data.name]
  )
  return ok(res, cat, 201)
}))

// ── PUT /api/admin/ai-categories/:id ─────────────────────────────────────
router.put('/ai-categories/:id', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ name: z.string().min(2).max(100) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [existing] = await query(`SELECT name FROM ai_categories WHERE name=$1`, [req.params.id])
  if (!existing) return fail(res, 'Category not found', 404)

  const [updated] = await query(
    `UPDATE ai_categories SET name=$1 WHERE name=$2 RETURNING *`,
    [parsed.data.name, req.params.id]
  )
  return ok(res, updated)
}))

// ── DELETE /api/admin/ai-categories/:id ──────────────────────────────────
router.delete('/ai-categories/:id', ...isAdmin, asyncHandler(async (req, res) => {
  const [existing] = await query(`SELECT name FROM ai_categories WHERE name=$1`, [req.params.id])
  if (!existing) return fail(res, 'Category not found', 404)

  await query(`DELETE FROM ai_categories WHERE name=$1`, [req.params.id])
  return ok(res, null)
}))

export default router
