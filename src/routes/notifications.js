import { Router } from 'express'
import { query } from '../lib/db.js'
import { ok, asyncHandler } from '../lib/response.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.session.userId]
  )
  return ok(res, rows)
}))

router.post('/read-all', requireAuth, asyncHandler(async (req, res) => {
  await query(
    `UPDATE notifications SET is_read=true WHERE user_id=$1`,
    [req.session.userId]
  )
  return ok(res, null)
}))

export default router
