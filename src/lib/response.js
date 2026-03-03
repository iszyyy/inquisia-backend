export function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data })
}

export function fail(res, message, status = 400, details = undefined) {
  const body = { success: false, error: message }
  if (details) body.details = details
  return res.status(status).json(body)
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
