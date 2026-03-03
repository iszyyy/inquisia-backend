import { Router } from 'express'
import { z } from 'zod'
import { query, transaction } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireRole, requireActive } from '../middleware/auth.js'

const router = Router()

const isAdmin = [requireRole('admin'), requireActive]

// ── Shared project SELECT ─────────────────────────────────────────────────
const PROJECT_SELECT = `
  SELECT
    p.*,
    d.name                        AS department_name,
    sv.full_name                  AS supervisor_name,
    sv.degrees                    AS supervisor_degrees,
    COALESCE(
      json_agg(
        json_build_object(
          'id',               u.id,
          'full_name',        u.full_name,
          'display_name',     u.display_name,
          'matric_no',        u.matric_no,
          'role_description', pa.role_description
        ) ORDER BY pa.is_lead DESC, u.full_name
      ) FILTER (WHERE u.id IS NOT NULL),
      '[]'
    ) AS authors
  FROM projects p
  LEFT JOIN departments d      ON d.id = p.department_id
  LEFT JOIN users sv           ON sv.id = p.supervisor_id
  LEFT JOIN project_authors pa ON pa.project_id = p.id
  LEFT JOIN users u            ON u.id = pa.user_id
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

// ════════════════════════════════════════════════════════════
//  USERS
// ════════════════════════════════════════════════════════════

// GET /api/admin/users
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
    `SELECT
       u.*,
       COUNT(DISTINCT pa.project_id)::int AS project_count
     FROM users u
     LEFT JOIN project_authors pa ON pa.user_id = u.id
     ${WHERE}
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    params
  )

  const users = rows.map(u => ({
    id: u.id,
    email: u.email,
    role: u.role,
    full_name: u.full_name,
    display_name: u.display_name,
    bio: u.bio,
    links: u.links ?? [],
    matric_no: u.matric_no,
    staff_id: u.staff_id,
    degrees: u.degrees,
    level: u.level,
    department_id: u.department_id,
    is_verified: u.is_verified,
    is_active: u.is_active,
    account_status: u.account_status,
    status_reason: u.status_reason,
    created_at: u.created_at,
    updated_at: u.updated_at,
    project_count: u.project_count,
  }))

  return ok(res, users)
}))

// PATCH /api/admin/users/:id/status
router.patch('/users/:id/status', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({
    status: z.enum(['active', 'warned', 'restricted', 'banned']),
    reason: z.string().min(1),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const { status, reason } = parsed.data

  const [user] = await query(
    `UPDATE users SET account_status=$1, status_reason=$2, updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [status, reason, req.params.id]
  )
  if (!user) return fail(res, 'User not found', 404)

  // Notify the user
  await query(
    `INSERT INTO notifications (user_id, type, title, message)
     VALUES ($1,'project_rejected',$2,$3)`,
    [user.id, `Account Status Updated`, reason]
  )

  return ok(res, {
    id: user.id, email: user.email, role: user.role,
    account_status: user.account_status, status_reason: user.status_reason,
    full_name: user.full_name, is_verified: user.is_verified,
    created_at: user.created_at, updated_at: user.updated_at,
  })
}))

// PATCH /api/admin/users/:id/verify — verify a supervisor
router.patch('/users/:id/verify', ...isAdmin, asyncHandler(async (req, res) => {
  const [user] = await query(
    `UPDATE users SET is_verified=true, updated_at=NOW()
     WHERE id=$1 AND role='supervisor' RETURNING *`,
    [req.params.id]
  )
  if (!user) return fail(res, 'Supervisor not found', 404)

  await query(
    `INSERT INTO notifications (user_id, type, title, message)
     VALUES ($1,'project_approved','Account Verified','Your supervisor account has been verified. You can now review student projects.')`,
    [user.id]
  )

  return ok(res, {
    id: user.id, email: user.email, role: user.role,
    is_verified: user.is_verified, full_name: user.full_name,
    account_status: user.account_status, created_at: user.created_at,
    updated_at: user.updated_at,
  })
}))

// ════════════════════════════════════════════════════════════
//  PROJECTS
// ════════════════════════════════════════════════════════════

// GET /api/admin/projects
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
     ORDER BY p.updated_at DESC`,
    params
  )

  return ok(res, rows.map(serializeProject))
}))

// PATCH /api/admin/projects/:id/status — admin force approve/reject
router.patch('/projects/:id/status', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({
    status: z.enum(['approved', 'rejected', 'pending', 'changes_requested']),
    reason: z.string().optional(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const { status, reason } = parsed.data
  const { id } = req.params

  const [project] = await query(`SELECT * FROM projects WHERE id=$1`, [id])
  if (!project) return fail(res, 'Project not found', 404)

  const approved_at = status === 'approved' ? `NOW()` : `approved_at`

  await transaction(async (client) => {
    await client.query(
      `UPDATE projects SET status=$1, updated_at=NOW(), approved_at=${approved_at} WHERE id=$2`,
      [status, id]
    )

    // Update latest version
    await client.query(
      `UPDATE project_versions SET status=$1
       WHERE project_id=$2 AND version_number=(
         SELECT MAX(version_number) FROM project_versions WHERE project_id=$2
       )`,
      [status, id]
    )

    // Notify lead author
    const [lead] = await client.query(
      `SELECT user_id FROM project_authors WHERE project_id=$1 AND is_lead=true LIMIT 1`,
      [id]
    ).then(r => r.rows)

    if (lead && reason) {
      const typeMap = {
        approved:          'project_approved',
        rejected:          'project_rejected',
        changes_requested: 'changes_requested',
        pending:           'project_approved',
      }
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, link)
         VALUES ($1,$2,'Admin Action',$3,$4)`,
        [lead.user_id, typeMap[status] || 'project_approved', reason, `/projects/${id}`]
      )
    }
  })

  const rows = await query(
    `${PROJECT_SELECT} WHERE p.id=$1 GROUP BY p.id, d.name, sv.full_name, sv.degrees`,
    [id]
  )
  return ok(res, serializeProject(rows[0]))
}))

// ════════════════════════════════════════════════════════════
//  DEPARTMENTS
// ════════════════════════════════════════════════════════════

// GET /api/admin/departments
router.get('/departments', ...isAdmin, asyncHandler(async (req, res) => {
  const rows = await query(`SELECT * FROM departments ORDER BY name`)
  return ok(res, rows)
}))

// POST /api/admin/departments
router.post('/departments', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ name: z.string().min(2).max(100) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [existing] = await query(`SELECT id FROM departments WHERE LOWER(name)=LOWER($1)`, [parsed.data.name])
  if (existing) return fail(res, 'Department already exists', 409)

  const [dept] = await query(
    `INSERT INTO departments (name) VALUES ($1) RETURNING *`,
    [parsed.data.name]
  )
  return ok(res, dept, 201)
}))

// PUT /api/admin/departments/:id
router.put('/departments/:id', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ name: z.string().min(2).max(100) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [dept] = await query(
    `UPDATE departments SET name=$1 WHERE id=$2 RETURNING *`,
    [parsed.data.name, req.params.id]
  )
  if (!dept) return fail(res, 'Department not found', 404)
  return ok(res, dept)
}))

// DELETE /api/admin/departments/:id
router.delete('/departments/:id', ...isAdmin, asyncHandler(async (req, res) => {
  const [inUse] = await query(
    `SELECT id FROM projects WHERE department_id=$1 LIMIT 1`,
    [req.params.id]
  )
  if (inUse) return fail(res, 'Cannot delete a department that has projects', 400)

  const [dept] = await query(`DELETE FROM departments WHERE id=$1 RETURNING id`, [req.params.id])
  if (!dept) return fail(res, 'Department not found', 404)
  return ok(res, null)
}))

// ════════════════════════════════════════════════════════════
//  AI CATEGORIES
// ════════════════════════════════════════════════════════════

// GET /api/admin/ai-categories
router.get('/ai-categories', ...isAdmin, asyncHandler(async (req, res) => {
  const rows = await query(`SELECT name FROM ai_categories ORDER BY name`)
  return ok(res, rows)
}))

// POST /api/admin/ai-categories
router.post('/ai-categories', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ name: z.string().min(2).max(100) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const [existing] = await query(`SELECT name FROM ai_categories WHERE LOWER(name)=LOWER($1)`, [parsed.data.name])
  if (existing) return fail(res, 'Category already exists', 409)

  const [cat] = await query(
    `INSERT INTO ai_categories (name) VALUES ($1) RETURNING *`,
    [parsed.data.name]
  )
  return ok(res, cat, 201)
}))

// PUT /api/admin/ai-categories/:id
router.put('/ai-categories/:id', ...isAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ name: z.string().min(2).max(100) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  // ai_categories uses name as PK
  const [cat] = await query(
    `UPDATE ai_categories SET name=$1 WHERE name=$2 RETURNING *`,
    [parsed.data.name, req.params.id]
  )
  if (!cat) return fail(res, 'Category not found', 404)
  return ok(res, cat)
}))

// DELETE /api/admin/ai-categories/:id
router.delete('/ai-categories/:id', ...isAdmin, asyncHandler(async (req, res) => {
  const [inUse] = await query(
    `SELECT id FROM projects WHERE ai_category=$1 LIMIT 1`,
    [req.params.id]
  )
  if (inUse) return fail(res, 'Cannot delete a category that has projects', 400)

  const [cat] = await query(`DELETE FROM ai_categories WHERE name=$1 RETURNING name`, [req.params.id])
  if (!cat) return fail(res, 'Category not found', 404)
  return ok(res, null)
}))

export default router
