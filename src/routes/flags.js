/**
 * GET /api/flags — public read-only feature flags
 * Frontend uses this to conditionally render features.
 * Returns a flat { key: boolean } map.
 */
import { Router } from 'express'
import { query } from '../lib/db.js'
import { ok, asyncHandler } from '../lib/response.js'

const router = Router()

router.get('/', asyncHandler(async (_req, res) => {
  const rows = await query('SELECT key, enabled FROM feature_flags ORDER BY key')
  const flags = Object.fromEntries(rows.map(r => [r.key, r.enabled]))
  return ok(res, flags)
}))

export default router
