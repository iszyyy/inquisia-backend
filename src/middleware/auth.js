import { fail } from '../lib/response.js'

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return fail(res, 'Unauthorized', 401)
  }
  next()
}

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

export function requireVerified(req, res, next) {
  if (!req.session.isVerified) {
    return fail(res, 'Your account is pending verification by an administrator.', 403)
  }
  next()
}

export function requireActive(req, res, next) {
  const status = req.session.accountStatus
  if (status === 'banned' || status === 'restricted') {
    return fail(res, 'Your account has been restricted. Please contact support.', 403)
  }
  next()
}
