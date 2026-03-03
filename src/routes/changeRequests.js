import { Router } from 'express'
import { z } from 'zod'
import { query, transaction } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireRole, requireActive, requireVerified } from '../middleware/auth.js'

const router = Router()

// ── PATCH /api/change-requests/:id/resolve — approve or deny ─────────────
router.patch(
  '/change-requests/:id/resolve',
  requireRole('supervisor', 'admin'),
  requireActive,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      status:   z.enum(['approved', 'denied']),
      response: z.string().min(1, 'Response message is required'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)
    }

    const { status, response } = parsed.data
    const { id } = req.params

    // Fetch the change request
    const [cr] = await query(
      `SELECT cr.*, p.supervisor_id, p.title AS project_title
       FROM change_requests cr
       JOIN projects p ON p.id = cr.project_id
       WHERE cr.id = $1`,
      [id]
    )
    if (!cr) return fail(res, 'Change request not found', 404)
    if (cr.status !== 'pending') return fail(res, 'This change request has already been resolved', 400)

    // Supervisors can only resolve change requests for their own projects
    if (req.session.role === 'supervisor' && cr.supervisor_id !== req.session.userId) {
      return fail(res, 'Forbidden', 403)
    }

    await transaction(async (client) => {
      // Update change request status
      await client.query(
        `UPDATE change_requests SET status=$1, response=$2, updated_at=NOW() WHERE id=$3`,
        [status, response, id]
      )

      // If approved — apply the proposed data changes to the project
      if (status === 'approved' && cr.proposed_data) {
        const allowed = ['title', 'abstract', 'github_url', 'live_url', 'student_tags']
        const updates = []
        const vals = []
        let idx = 1

        for (const field of cr.fields) {
          if (allowed.includes(field) && cr.proposed_data[field] !== undefined) {
            updates.push(`${field} = $${idx}`)
            vals.push(cr.proposed_data[field])
            idx++
          }
        }

        if (updates.length) {
          vals.push(cr.project_id)
          await client.query(
            `UPDATE projects SET ${updates.join(', ')}, updated_at=NOW() WHERE id=$${idx}`,
            vals
          )
        }
      }

      // Notify the student
      const notifType = status === 'approved'
        ? 'change_request_approved'
        : 'change_request_denied'
      const notifTitle = status === 'approved'
        ? 'Change Request Approved'
        : 'Change Request Denied'

      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, link)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          cr.student_id,
          notifType,
          notifTitle,
          response,
          `/projects/${cr.project_id}`,
        ]
      )
    })

    const [updated] = await query(
      `SELECT cr.*, p.title AS project_title
       FROM change_requests cr
       JOIN projects p ON p.id = cr.project_id
       WHERE cr.id = $1`,
      [id]
    )

    return ok(res, updated)
  })
)

export default router
