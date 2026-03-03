import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { query, transaction } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// ── Helpers ──────────────────────────────────────────────────

/** Serialise a DB user row into the shape the frontend expects. */
function serializeUser(row) {
  return {
    id:             row.id,
    email:          row.email,
    role:           row.role,
    full_name:      row.full_name,
    display_name:   row.display_name,
    bio:            row.bio,
    links:          row.links ?? [],
    matric_no:      row.matric_no,
    staff_id:       row.staff_id,
    degrees:        row.degrees,
    level:          row.level,
    department_id:  row.department_id,
    is_verified:    row.is_verified,
    is_active:      row.is_active,
    account_status: row.account_status,
    status_reason:  row.status_reason,
    created_at:     row.created_at,
    updated_at:     row.updated_at,
  }
}

/** Write session data after successful auth. */
function setSession(req, user) {
  req.session.userId        = user.id
  req.session.role          = user.role
  req.session.isVerified    = user.is_verified
  req.session.accountStatus = user.account_status
}

// ── Validation schemas ────────────────────────────────────────

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})

const registerSchema = z.object({
  email:         z.string().email(),
  password:      z.string().min(8, 'Password must be at least 8 characters'),
  role:          z.enum(['student', 'supervisor', 'public']),
  full_name:     z.string().max(120).optional(),
  display_name:  z.string().max(60).optional(),
  // Student fields
  matric_no:     z.string().max(30).optional(),
  level:         z.enum(['100', '200', '300', '400', '500']).optional(),
  department_id: z.string().uuid().optional(),
  // Supervisor fields
  staff_id:      z.string().max(40).optional(),
  degrees:       z.string().max(200).optional(),
})

// ── GET /api/auth/session ─────────────────────────────────────

router.get('/session', requireAuth, asyncHandler(async (req, res) => {
  const [user] = await query('SELECT * FROM users WHERE id = $1', [req.session.userId])
  if (!user) {
    req.session.destroy(() => {})
    return fail(res, 'Session expired', 401)
  }
  // Refresh session fields (role/status may have changed)
  setSession(req, user)
  return res.json({ success: true, user: serializeUser(user) })
}))

// ── POST /api/auth/login ──────────────────────────────────────

router.post('/login', asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return fail(res, 'Invalid input', 400, parsed.error.flatten().fieldErrors)
  }

  const { email, password } = parsed.data
  const [user] = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()])
  if (!user) return fail(res, 'Invalid email or password', 401)

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) return fail(res, 'Invalid email or password', 401)

  if (user.account_status === 'banned' || user.account_status === 'restricted') {
    return fail(res, 'Your account has been restricted. Please contact support.', 403)
  }

  setSession(req, user)
  return res.json({ success: true, user: serializeUser(user) })
}))

// ── POST /api/auth/register ───────────────────────────────────

router.post('/register', asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    return fail(res, 'Validation error', 400, parsed.error.flatten().fieldErrors)
  }

  const data = parsed.data
  const email = data.email.toLowerCase()

  // Check duplicate
  const [existing] = await query('SELECT id FROM users WHERE email = $1', [email])
  if (existing) return fail(res, 'An account with this email already exists.', 409)

  const passwordHash = await bcrypt.hash(data.password, 12)

  // Students are immediately active; supervisors need admin verification
  const isVerified = data.role !== 'supervisor'

  const user = await transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users
         (email, password_hash, role, full_name, display_name, matric_no, staff_id,
          degrees, level, department_id, is_verified, is_active, account_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,'active')
       RETURNING *`,
      [
        email,
        passwordHash,
        data.role,
        data.full_name   || null,
        data.display_name || null,
        data.matric_no   || null,
        data.staff_id    || null,
        data.degrees     || null,
        data.level       || null,
        data.department_id || null,
        isVerified,
      ]
    )
    const newUser = rows[0]

    // If supervisor, link to department in supervisor_departments table
    if (data.role === 'supervisor' && data.department_id) {
      await client.query(
        'INSERT INTO supervisor_departments (supervisor_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [newUser.id, data.department_id]
      )
    }

    return newUser
  })

  setSession(req, user)
  return res.status(201).json({ success: true, user: serializeUser(user) })
}))

// ── POST /api/auth/logout ─────────────────────────────────────

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid')
    return res.json({ success: true, data: null })
  })
})

export default router
