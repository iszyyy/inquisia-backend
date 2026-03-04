import { Router } from 'express'
import { z } from 'zod'
import { query, transaction } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireRole, requireActive, requireVerified } from '../middleware/auth.js'

const router = Router()

// ── Shared project SELECT (same as projects.js) ───────────────────────────
const PROJECT_SELECT = `
  SELECT
    p.*,
    d.name                        AS department_name,
    sv.full_name                  AS supervisor_name,
    sv.degrees                    AS supervisor_degrees,
    COALESCE(
      json_agg(
        json_build_object(
          'id',               u.id,
          'full_name',        u.full_name,
          'display_name',     u.display_name,
          'matric_no',        u.matric_no,
          'role_description', pa.role_description
        ) ORDER BY pa.is_lead DESC, u.full_name
      ) FILTER (WHERE u.id IS NOT NULL),
      '[]'
    ) AS authors
  FROM projects p
  LEFT JOIN departments d   ON d.id = p.department_id
  LEFT JOIN users sv        ON sv.id = p.supervisor_id
  LEFT JOIN project_authors pa ON pa.project_id = p.id
  LEFT JOIN users u         ON u.id = pa.user_id
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

// ── GET /api/supervisor/projects — all projects assigned to this supervisor
router.get(
  '/projects',
  requireRole('supervisor'),
  requireVerified,
  requireActive,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `${PROJECT_SELECT}
       WHERE p.supervisor_id = $1
       GROUP BY p.id, d.name, sv.full_name, sv.degrees
       ORDER BY
         CASE p.status
           WHEN 'pending'            THEN 1
           WHEN 'changes_requested'  THEN 2
           WHEN 'rejected'           THEN 3
           WHEN 'approved'           THEN 4
         END,
         p.updated_at DESC`,
      [req.session.userId]
    )
    return ok(res, rows.map(serializeProject))
  })
)

// ── GET /api/supervisor/change-requests — pending change requests ─────────
router.get(
  '/change-requests',
  requireRole('supervisor'),
  requireVerified,
  requireActive,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT
         cr.*,
         p.title        AS project_title,
         p.status       AS project_status,
         u.full_name    AS student_name,
         u.matric_no    AS student_matric
       FROM change_requests cr
       JOIN projects p ON p.id = cr.project_id
       JOIN users u    ON u.id = cr.student_id
       WHERE p.supervisor_id = $1
         AND cr.status = 'pending'
       ORDER BY cr.created_at DESC`,
      [req.session.userId]
    )
    return ok(res, rows)
  })
)

export default router
