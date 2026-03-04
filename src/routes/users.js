import { Router } from 'express'
import { z } from 'zod'
import { query } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireAuth, requireActive } from '../middleware/auth.js'

const router = Router()

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
  }
}

// ── GET /api/users/lookup?matric_no= ─────────────────────────────────────
router.get('/lookup', requireAuth, asyncHandler(async (req, res) => {
  const { matric_no } = req.query
  if (!matric_no) return fail(res, 'matric_no is required', 400)

  const [user] = await query(
    `SELECT id, full_name, display_name, matric_no
     FROM users WHERE matric_no = $1 AND role = 'student'`,
    [matric_no]
  )
  if (!user) return fail(res, 'Student not found', 404)
  return ok(res, user)
}))

// ── GET /api/users/:id ────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const [user] = await query(
    `SELECT * FROM users WHERE id=$1`,
    [req.params.id]
  )
  if (!user) return fail(res, 'User not found', 404)
  return ok(res, serializeUser(user))
}))

// ── PATCH /api/users/:id ──────────────────────────────────────────────────
router.patch('/:id', requireAuth, requireActive, asyncHandler(async (req, res) => {
  if (req.params.id !== req.session.userId && req.session.role !== 'admin') {
    return fail(res, 'Forbidden', 403)
  }

  const schema = z.object({
    full_name:    z.string().min(1).max(100).optional(),
    display_name: z.string().max(50).optional().nullable(),
    bio:          z.string().max(500).optional().nullable(),
    links:        z.array(z.object({
      title: z.string(),
      url:   z.string().url(),
    })).optional(),
    degrees:      z.string().max(200).optional().nullable(),
    level:        z.string().optional().nullable(),
    department_id: z.string().uuid().optional().nullable(),
    staff_id:     z.string().optional().nullable(),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)
  }

  const fields = parsed.data
  const keys = Object.keys(fields)
  if (!keys.length) return fail(res, 'No fields to update', 400)

  const setClauses = keys.map((k, i) => `${k}=$${i + 1}`)
  const values = keys.map(k => fields[k])
  values.push(req.params.id)

  await query(
    `UPDATE users SET ${setClauses.join(', ')}, updated_at=NOW() WHERE id=$${values.length}`,
    values
  )

  const [updated] = await query(`SELECT * FROM users WHERE id=$1`, [req.params.id])
  return ok(res, serializeUser(updated))
}))

export default router
