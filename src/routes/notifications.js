import { Router } from 'express'
import { query } from '../lib/db.js'
import { ok, asyncHandler } from '../lib/response.js'
import { requireAuth, requireActive } from '../middleware/auth.js'

const router = Router()

// ── GET /api/notifications ────────────────────────────────────────────────
router.get('/', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const notifications = await query(
    `SELECT * FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.session.userId]
  )
  return ok(res, notifications)
}))

// ── POST /api/notifications/read-all ─────────────────────────────────────
router.post('/read-all', requireAuth, asyncHandler(async (req, res) => {
  await query(
    `UPDATE notifications SET is_read=true WHERE user_id=$1 AND is_read=false`,
    [req.session.userId]
  )
  return ok(res, null)
}))

export default router
