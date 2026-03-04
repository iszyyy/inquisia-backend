import { Router } from 'express'
import { z } from 'zod'
import { query } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireAuth, requireActive } from '../middleware/auth.js'

const router = Router()

// ── Helper: build threaded comment tree ───────────────────────────────────
function buildTree(rows) {
  const map = {}
  const roots = []

  for (const row of rows) {
    map[row.id] = { ...row, replies: [] }
  }

  for (const row of rows) {
    if (row.parent_id && map[row.parent_id]) {
      map[row.parent_id].replies.push(map[row.id])
    } else {
      roots.push(map[row.id])
    }
  }

  return roots
}

function serializeComment(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    author_id: row.user_id,
    author_name: row.full_name ?? null,
    author_display_name: row.display_name ?? null,
    author_role: row.role ?? 'public',
    is_admin: row.role === 'admin',
    is_supervisor: row.role === 'supervisor',
    is_author: !!row.is_author,
    content: row.is_deleted ? '[deleted]' : row.content,
    is_deleted: !!row.is_deleted,
    parent_id: row.parent_id ?? null,
    replies: (row.replies || []).map(serializeComment),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── GET /api/projects/:id/comments ────────────────────────────────────────
router.get('/projects/:id/comments', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT
       c.*,
       u.full_name,
       u.display_name,
       u.role,
       EXISTS (
         SELECT 1 FROM project_authors pa
         WHERE pa.project_id = c.project_id AND pa.user_id = c.user_id
       ) AS is_author
     FROM comments c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.project_id = $1
     ORDER BY c.created_at ASC`,
    [req.params.id]
  )

  const tree = buildTree(rows)
  return ok(res, tree.map(serializeComment))
}))

// ── POST /api/projects/:id/comments ──────────────────────────────────────
router.post(
  '/projects/:id/comments',
  requireAuth,
  requireActive,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      content:   z.string().min(1).max(2000),
      parent_id: z.string().uuid().optional().nullable(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)
    }

    const { content, parent_id } = parsed.data

    // Verify project exists
    const [project] = await query(`SELECT id FROM projects WHERE id=$1`, [req.params.id])
    if (!project) return fail(res, 'Project not found', 404)

    // Verify parent comment belongs to same project
    if (parent_id) {
      const [parent] = await query(
        `SELECT id FROM comments WHERE id=$1 AND project_id=$2`,
        [parent_id, req.params.id]
      )
      if (!parent) return fail(res, 'Parent comment not found', 404)
    }

    const [comment] = await query(
      `INSERT INTO comments (project_id, user_id, content, parent_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.session.userId, content, parent_id || null]
    )

    // Fetch with user info
    const [full] = await query(
      `SELECT c.*, u.full_name, u.display_name, u.role,
         EXISTS (
           SELECT 1 FROM project_authors pa
           WHERE pa.project_id = c.project_id AND pa.user_id = c.user_id
         ) AS is_author
       FROM comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.id = $1`,
      [comment.id]
    )

    return ok(res, serializeComment({ ...full, replies: [] }), 201)
  })
)

// ── PATCH /api/comments/:id ───────────────────────────────────────────────
router.patch('/comments/:id', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const schema = z.object({
    content: z.string().min(1).max(2000),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)
  }

  const [comment] = await query(`SELECT * FROM comments WHERE id=$1`, [req.params.id])
  if (!comment) return fail(res, 'Comment not found', 404)
  if (comment.user_id !== req.session.userId && req.session.role !== 'admin') {
    return fail(res, 'Forbidden', 403)
  }
  if (comment.is_deleted) return fail(res, 'Cannot edit a deleted comment', 400)

  await query(
    `UPDATE comments SET content=$1, updated_at=NOW() WHERE id=$2`,
    [parsed.data.content, req.params.id]
  )

  const [full] = await query(
    `SELECT c.*, u.full_name, u.display_name, u.role,
       EXISTS (
         SELECT 1 FROM project_authors pa
         WHERE pa.project_id = c.project_id AND pa.user_id = c.user_id
       ) AS is_author
     FROM comments c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.id = $1`,
    [req.params.id]
  )

  return ok(res, serializeComment({ ...full, replies: [] }))
}))

// ── DELETE /api/comments/:id ──────────────────────────────────────────────
router.delete('/comments/:id', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const [comment] = await query(`SELECT * FROM comments WHERE id=$1`, [req.params.id])
  if (!comment) return fail(res, 'Comment not found', 404)
  if (comment.user_id !== req.session.userId && req.session.role !== 'admin') {
    return fail(res, 'Forbidden', 403)
  }

  // Soft delete
  await query(`UPDATE comments SET is_deleted=true, content='', updated_at=NOW() WHERE id=$1`, [req.params.id])
  return ok(res, null)
}))

export default router
