import { fail } from '../lib/response.js'
import { query } from '../lib/db.js'

/**
 * requireAuth — return 401 if not logged in.
 */
export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return fail(res, 'Unauthorized', 401)
  }
  next()
}

/**
 * requireRole(...roles) — gate a route to specific roles.
 * Always implies requireAuth.
 */
export function requireRole(...roles) {
  return [
    requireAuth,
    (req, res, next) => {
      if (!roles.includes(req.session.role)) {
        return fail(res, 'Forbidden', 403)
      }
      next()
    },
  ]
}

/**
 * requireSuperAdmin — only users with is_super_admin=true.
 * Always implies requireAuth.
 */
export function requireSuperAdmin(req, res, next) {
  if (!req.session?.userId) {
    return fail(res, 'Unauthorized', 401)
  }
  if (!req.session.isSuperAdmin) {
    return fail(res, 'Super admin access required', 403)
  }
  next()
}

/**
 * requireVerified — supervisors must be verified.
 */
export function requireVerified(req, res, next) {
  if (!req.session.isVerified) {
    return fail(res, 'Your account is pending verification by an administrator.', 403)
  }
  next()
}

/**
 * requireActive — reject banned/restricted users.
 */
export function requireActive(req, res, next) {
  const status = req.session.accountStatus
  if (status === 'banned' || status === 'restricted') {
    return fail(res, 'Your account has been restricted. Please contact support.', 403)
  }
  next()
}

/**
 * auditLog — write an entry to admin_audit_log.
 * Call this from route handlers directly (not as middleware).
 */
export async function auditLog({ req, action, targetType, targetId, before, after }) {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || null

    await query(
      `INSERT INTO admin_audit_log
         (actor_id, action, target_type, target_id, before_data, after_data, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.session?.userId || null,
        action,
        targetType || null,
        targetId ? String(targetId) : null,
        before ? JSON.stringify(before) : null,
        after  ? JSON.stringify(after)  : null,
        ip,
      ]
    )
  } catch (e) {
    console.error('[AuditLog] Failed to write:', e.message)
  }
}
