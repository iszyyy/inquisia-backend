import { Router } from 'express'
import { z } from 'zod'
import { query } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireAuth, requireActive } from '../middleware/auth.js'

const router = Router()

const PROJECT_SELECT = `
  SELECT
    p.*,
    d.name AS department_name,
    sv.full_name AS supervisor_name,
    sv.degrees AS supervisor_degrees,
    COALESCE(
      json_agg(
        json_build_object(
          'id', u.id,
          'full_name', u.full_name,
          'display_name', u.display_name,
          'matric_no', u.matric_no,
          'role_description', pa.role_description
        ) ORDER BY pa.is_lead DESC, u.full_name
      ) FILTER (WHERE u.id IS NOT NULL),
      '[]'
    ) AS authors
  FROM projects p
  LEFT JOIN departments d ON d.id = p.department_id
  LEFT JOIN users sv ON sv.id = p.supervisor_id
  LEFT JOIN project_authors pa ON pa.project_id = p.id
  LEFT JOIN users u ON u.id = pa.user_id
`

function serializeProject(row) {
  return {
    id: row.id,
    title: row.title,
    abstract: row.abstract,
    pdf_text: row.pdf_text ?? null,
    student_tags: row.student_tags ?? [],
    ai_tags: row.ai_tags ?? [],
    ai_category: row.ai_category ?? null,
    department_id: row.department_id ?? null,
    department_name: row.department_name ?? null,
    year: row.year,
    status: row.status,
    plagiarism_score: row.plagiarism_score ?? null,
    similar_project_id: row.similar_project_id ?? null,
    similarity_reason: row.similarity_reason ?? null,
    github_url: row.github_url ?? null,
    live_url: row.live_url ?? null,
    report_url: row.report_url ?? null,
    download_count: row.download_count ?? 0,
    supervisor_id: row.supervisor_id ?? null,
    supervisor_name: row.supervisor_name ?? null,
    supervisor_degrees: row.supervisor_degrees ?? null,
    authors: row.authors ?? [],
    ai_summary: row.ai_summary ?? null,
    ai_analysis: row.ai_analysis ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at ?? null,
  }
}

// ── GET /api/bookmarks ────────────────────────────────────────────────────
router.get('/', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const rows = await query(
    `${PROJECT_SELECT}
     INNER JOIN bookmarks b ON b.project_id = p.id
     WHERE b.user_id = $1
     GROUP BY p.id, d.name, sv.full_name, sv.degrees
     ORDER BY b.created_at DESC`,
    [req.session.userId]
  )
  return ok(res, rows.map(serializeProject))
}))

// ── GET /api/bookmarks/:projectId — check if bookmarked ──────────────────
router.get('/:projectId', requireAuth, asyncHandler(async (req, res) => {
  const [bookmark] = await query(
    `SELECT 1 FROM bookmarks WHERE user_id=$1 AND project_id=$2`,
    [req.session.userId, req.params.projectId]
  )
  return ok(res, { is_bookmarked: !!bookmark })
}))

// ── POST /api/bookmarks ───────────────────────────────────────────────────
router.post('/', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const schema = z.object({
    project_id: z.string().uuid(),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400)

  const [project] = await query(`SELECT id FROM projects WHERE id=$1`, [parsed.data.project_id])
  if (!project) return fail(res, 'Project not found', 404)

  await query(
    `INSERT INTO bookmarks (user_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.session.userId, parsed.data.project_id]
  )
  return ok(res, null, 201)
}))

// ── DELETE /api/bookmarks/:projectId ─────────────────────────────────────
router.delete('/:projectId', requireAuth, asyncHandler(async (req, res) => {
  await query(
    `DELETE FROM bookmarks WHERE user_id=$1 AND project_id=$2`,
    [req.session.userId, req.params.projectId]
  )
  return ok(res, null)
}))

export default router
