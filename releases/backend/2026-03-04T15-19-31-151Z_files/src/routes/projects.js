import { Router } from 'express'
import { z } from 'zod'
import { query, transaction } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireAuth, requireRole, requireActive } from '../middleware/auth.js'
import { uploadPdf } from '../middleware/upload.js'
import path from 'path'
import fs from 'fs'

const router = Router()

// ── Helpers ────────────────────────────────────────────────────────────────

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

// Full project query with authors, supervisor, department
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

// ── GET /api/projects/public — browse approved projects ────────────────────
router.get('/public', asyncHandler(async (req, res) => {
  const {
    query: q,
    author,
    department_id,
    ai_category,
    year,
    sort = 'recent',
    page = '1',
    limit = '12',
  } = req.query

  const pageNum  = Math.max(1, parseInt(page) || 1)
  const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 12))
  const offset   = (pageNum - 1) * limitNum

  const conditions = [`p.status = 'approved'`]
  const params = []
  let i = 1

  if (q) {
    conditions.push(`(p.title ILIKE $${i} OR p.abstract ILIKE $${i})`)
    params.push(`%${q}%`)
    i++
  }
  if (department_id) {
    conditions.push(`p.department_id = $${i}`)
    params.push(department_id)
    i++
  }
  if (ai_category) {
    conditions.push(`p.ai_category = $${i}`)
    params.push(ai_category)
    i++
  }
  if (year) {
    conditions.push(`p.year = $${i}`)
    params.push(parseInt(year))
    i++
  }
  if (author) {
    conditions.push(`EXISTS (
      SELECT 1 FROM project_authors pa2
      JOIN users u2 ON u2.id = pa2.user_id
      WHERE pa2.project_id = p.id
        AND (u2.full_name ILIKE $${i} OR u2.display_name ILIKE $${i})
    )`)
    params.push(`%${author}%`)
    i++
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const orderMap = {
    recent:    'p.approved_at DESC NULLS LAST',
    oldest:    'p.approved_at ASC NULLS LAST',
    downloads: 'p.download_count DESC',
    title:     'p.title ASC',
  }
  const ORDER = orderMap[sort] || orderMap.recent

  const countRes = await query(
    `SELECT COUNT(*) FROM projects p ${WHERE}`,
    params
  )
  const total = parseInt(countRes[0].count)

  const rows = await query(
    `${PROJECT_SELECT} ${WHERE}
     GROUP BY p.id, d.name, sv.full_name, sv.degrees
     ORDER BY ${ORDER}
     LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limitNum, offset]
  )

  return res.json({
    success: true,
    items: rows.map(serializeProject),
    total,
    page: pageNum,
    limit: limitNum,
    total_pages: Math.ceil(total / limitNum),
  })
}))

// ── GET /api/projects/:id/public — single public project ──────────────────
router.get('/:id/public', asyncHandler(async (req, res) => {
  const rows = await query(
    `${PROJECT_SELECT}
     WHERE p.id = $1 AND p.status = 'approved'
     GROUP BY p.id, d.name, sv.full_name, sv.degrees`,
    [req.params.id]
  )
  if (!rows.length) return fail(res, 'Project not found', 404)
  return ok(res, serializeProject(rows[0]))
}))

// ── GET /api/projects — my projects (authenticated) ───────────────────────
router.get('/', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const userId = req.session.userId
  const role   = req.session.role

  let rows
  if (role === 'supervisor') {
    rows = await query(
      `${PROJECT_SELECT}
       WHERE p.supervisor_id = $1
       GROUP BY p.id, d.name, sv.full_name, sv.degrees
       ORDER BY p.updated_at DESC`,
      [userId]
    )
  } else {
    rows = await query(
      `${PROJECT_SELECT}
       WHERE p.id IN (
         SELECT project_id FROM project_authors WHERE user_id = $1
       )
       GROUP BY p.id, d.name, sv.full_name, sv.degrees
       ORDER BY p.updated_at DESC`,
      [userId]
    )
  }

  return ok(res, rows.map(serializeProject))
}))

// ── POST /api/projects — create project ───────────────────────────────────
router.post(
  '/',
  requireRole('student'),
  requireActive,
  uploadPdf.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'PDF file is required', 400)

    let metadata
    try {
      metadata = JSON.parse(req.body.metadata || '{}')
    } catch {
      return fail(res, 'Invalid metadata JSON', 400)
    }

    const schema = z.object({
      title:        z.string().min(5).max(300),
      abstract:     z.string().min(20).max(5000),
      supervisor_id: z.string().uuid().optional().nullable(),
      github_url:   z.string().url().optional().nullable(),
      live_url:     z.string().url().optional().nullable(),
      co_authors:   z.array(z.string().uuid()).optional(),
      student_tags: z.array(z.string()).optional(),
    })

    const parsed = schema.safeParse(metadata)
    if (!parsed.success) {
      return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)
    }

    const {
      title, abstract, supervisor_id, github_url, live_url,
      co_authors = [], student_tags = [],
    } = parsed.data

    const FILE_BASE_URL = process.env.FILE_BASE_URL || 'http://localhost:3000/files'
    const report_url = `${FILE_BASE_URL}/${req.file.filename}`
    const year = new Date().getFullYear()

    const project = await transaction(async (client) => {
      const [proj] = await client.query(
        `INSERT INTO projects
           (title, abstract, student_tags, year, report_url, supervisor_id, github_url, live_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
         RETURNING *`,
        [title, abstract, student_tags, year, report_url, supervisor_id || null, github_url || null, live_url || null]
      ).then(r => r.rows)

      // Lead author
      await client.query(
        `INSERT INTO project_authors (project_id, user_id, is_lead) VALUES ($1,$2,true)`,
        [proj.id, req.session.userId]
      )

      // Co-authors
      for (const coId of co_authors) {
        if (coId !== req.session.userId) {
          await client.query(
            `INSERT INTO project_authors (project_id, user_id, is_lead)
             VALUES ($1,$2,false) ON CONFLICT DO NOTHING`,
            [proj.id, coId]
          )
        }
      }

      // Initial version
      await client.query(
        `INSERT INTO project_versions
           (project_id, version_number, status, report_url)
         VALUES ($1, 1, 'pending', $2)`,
        [proj.id, report_url]
      )

      return proj
    })

    // Fetch full project with authors
    const rows = await query(
      `${PROJECT_SELECT}
       WHERE p.id = $1
       GROUP BY p.id, d.name, sv.full_name, sv.degrees`,
      [project.id]
    )

    return ok(res, serializeProject(rows[0]), 201)
  })
)

// ── PATCH /api/projects/:id — update pending project ─────────────────────
router.patch(
  '/:id',
  requireAuth,
  requireActive,
  uploadPdf.single('file'),
  asyncHandler(async (req, res) => {
    const { id } = req.params

    const [existing] = await query(
      `SELECT p.*, (SELECT user_id FROM project_authors WHERE project_id=p.id AND is_lead=true LIMIT 1) AS lead_id
       FROM projects p WHERE p.id = $1`,
      [id]
    )
    if (!existing) return fail(res, 'Project not found', 404)
    if (existing.lead_id !== req.session.userId && req.session.role !== 'admin') {
      return fail(res, 'Forbidden', 403)
    }
    if (!['pending', 'changes_requested'].includes(existing.status)) {
      return fail(res, 'Only pending or changes_requested projects can be edited', 400)
    }

    let metadata
    try {
      metadata = JSON.parse(req.body.metadata || '{}')
    } catch {
      return fail(res, 'Invalid metadata JSON', 400)
    }

    const FILE_BASE_URL = process.env.FILE_BASE_URL || 'http://localhost:3000/files'
    const report_url = req.file
      ? `${FILE_BASE_URL}/${req.file.filename}`
      : existing.report_url

    const title        = metadata.title        ?? existing.title
    const abstract     = metadata.abstract     ?? existing.abstract
    const github_url   = metadata.github_url   ?? existing.github_url
    const live_url     = metadata.live_url     ?? existing.live_url
    const student_tags = metadata.student_tags ?? existing.student_tags
    const supervisor_id = metadata.supervisor_id !== undefined
      ? metadata.supervisor_id
      : existing.supervisor_id

    await query(
      `UPDATE projects SET
         title=$1, abstract=$2, github_url=$3, live_url=$4,
         student_tags=$5, supervisor_id=$6, report_url=$7, updated_at=NOW()
       WHERE id=$8`,
      [title, abstract, github_url, live_url, student_tags, supervisor_id, report_url, id]
    )

    const rows = await query(
      `${PROJECT_SELECT} WHERE p.id=$1 GROUP BY p.id, d.name, sv.full_name, sv.degrees`,
      [id]
    )
    return ok(res, serializeProject(rows[0]))
  })
)

// ── DELETE /api/projects/:id ──────────────────────────────────────────────
router.delete('/:id', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const [existing] = await query(
    `SELECT p.*, (SELECT user_id FROM project_authors WHERE project_id=p.id AND is_lead=true LIMIT 1) AS lead_id
     FROM projects p WHERE p.id = $1`,
    [req.params.id]
  )
  if (!existing) return fail(res, 'Project not found', 404)
  if (existing.lead_id !== req.session.userId && req.session.role !== 'admin') {
    return fail(res, 'Forbidden', 403)
  }
  if (existing.status === 'approved') {
    return fail(res, 'Approved projects cannot be deleted', 400)
  }

  await query('DELETE FROM projects WHERE id=$1', [req.params.id])
  return ok(res, null)
}))

// ── GET /api/projects/:id/versions ────────────────────────────────────────
router.get('/:id/versions', requireAuth, asyncHandler(async (req, res) => {
  const versions = await query(
    `SELECT * FROM project_versions WHERE project_id=$1 ORDER BY version_number DESC`,
    [req.params.id]
  )
  return ok(res, versions)
}))

// ── GET /api/projects/:id/related ─────────────────────────────────────────
router.get('/:id/related', asyncHandler(async (req, res) => {
  const [project] = await query(
    `SELECT ai_category, department_id FROM projects WHERE id=$1`,
    [req.params.id]
  )
  if (!project) return ok(res, [])

  const category = req.query.category || project.ai_category

  const rows = await query(
    `${PROJECT_SELECT}
     WHERE p.status='approved'
       AND p.id != $1
       AND (p.ai_category=$2 OR p.department_id=$3)
     GROUP BY p.id, d.name, sv.full_name, sv.degrees
     ORDER BY p.approved_at DESC NULLS LAST
     LIMIT 6`,
    [req.params.id, category, project.department_id]
  )
  return ok(res, rows.map(serializeProject))
}))

// ── GET /api/projects/:id/download ────────────────────────────────────────
router.get('/:id/download', asyncHandler(async (req, res) => {
  const [project] = await query(
    `SELECT id, report_url, status FROM projects WHERE id=$1`,
    [req.params.id]
  )
  if (!project) return fail(res, 'Project not found', 404)
  if (project.status !== 'approved') return fail(res, 'Project not available for download', 403)
  if (!project.report_url) return fail(res, 'No file available', 404)

  await query(
    `UPDATE projects SET download_count = download_count + 1 WHERE id=$1`,
    [project.id]
  )

  return ok(res, { url: project.report_url })
}))

// ── PATCH /api/projects/:id/status — supervisor review ───────────────────
router.patch('/:id/status', requireRole('supervisor', 'admin'), requireActive, asyncHandler(async (req, res) => {
  const schema = z.object({
    status:   z.enum(['approved', 'changes_requested', 'rejected']),
    feedback: z.string().min(1),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400, parsed.error.flatten().fieldErrors)

  const { status, feedback } = parsed.data
  const { id } = req.params

  const [project] = await query(`SELECT * FROM projects WHERE id=$1`, [id])
  if (!project) return fail(res, 'Project not found', 404)

  if (req.session.role === 'supervisor' && project.supervisor_id !== req.session.userId) {
    return fail(res, 'You are not the supervisor of this project', 403)
  }

  const approved_at = status === 'approved' ? 'NOW()' : 'approved_at'

  await transaction(async (client) => {
    await client.query(
      `UPDATE projects SET status=$1, updated_at=NOW(), approved_at=${approved_at} WHERE id=$2`,
      [status, id]
    )

    // Update the latest version
    await client.query(
      `UPDATE project_versions SET status=$1, supervisor_feedback=$2
       WHERE project_id=$3 AND version_number=(
         SELECT MAX(version_number) FROM project_versions WHERE project_id=$3
       )`,
      [status, feedback, id]
    )

    // Notify the lead author
    const [lead] = await client.query(
      `SELECT user_id FROM project_authors WHERE project_id=$1 AND is_lead=true LIMIT 1`,
      [id]
    ).then(r => r.rows)

    if (lead) {
      const typeMap = {
        approved:           'project_approved',
        changes_requested:  'changes_requested',
        rejected:           'project_rejected',
      }
      const titleMap = {
        approved:           'Project Approved',
        changes_requested:  'Changes Requested',
        rejected:           'Project Rejected',
      }
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, link)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          lead.user_id,
          typeMap[status],
          titleMap[status],
          feedback,
          `/projects/${id}`,
        ]
      )
    }
  })

  const rows = await query(
    `${PROJECT_SELECT} WHERE p.id=$1 GROUP BY p.id, d.name, sv.full_name, sv.degrees`,
    [id]
  )
  return ok(res, serializeProject(rows[0]))
}))

// ── POST /api/projects/:id/revision — submit revision ────────────────────
router.post(
  '/:id/revision',
  requireRole('student'),
  requireActive,
  uploadPdf.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'PDF file is required', 400)

    const [project] = await query(
      `SELECT p.*, (SELECT user_id FROM project_authors WHERE project_id=p.id AND is_lead=true LIMIT 1) AS lead_id
       FROM projects p WHERE p.id=$1`,
      [req.params.id]
    )
    if (!project) return fail(res, 'Project not found', 404)
    if (project.lead_id !== req.session.userId) return fail(res, 'Forbidden', 403)
    if (project.status !== 'changes_requested') {
      return fail(res, 'Project is not in changes_requested status', 400)
    }

    let metadata = {}
    try { metadata = JSON.parse(req.body.metadata || '{}') } catch {}

    const FILE_BASE_URL = process.env.FILE_BASE_URL || 'http://localhost:3000/files'
    const report_url = `${FILE_BASE_URL}/${req.file.filename}`

    const [latest] = await query(
      `SELECT MAX(version_number) AS max FROM project_versions WHERE project_id=$1`,
      [req.params.id]
    )
    const nextVersion = (latest?.max || 0) + 1

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO project_versions (project_id, version_number, status, report_url)
         VALUES ($1,$2,'pending',$3)`,
        [project.id, nextVersion, report_url]
      )
      await client.query(
        `UPDATE projects SET status='pending', report_url=$1, updated_at=NOW() WHERE id=$2`,
        [report_url, project.id]
      )
    })

    const rows = await query(
      `${PROJECT_SELECT} WHERE p.id=$1 GROUP BY p.id, d.name, sv.full_name, sv.degrees`,
      [project.id]
    )
    return ok(res, serializeProject(rows[0]))
  })
)

// ── POST /api/projects/:id/resubmit — resubmit rejected project ──────────
router.post(
  '/:id/resubmit',
  requireRole('student'),
  requireActive,
  uploadPdf.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return fail(res, 'PDF file is required', 400)

    const [project] = await query(
      `SELECT p.*, (SELECT user_id FROM project_authors WHERE project_id=p.id AND is_lead=true LIMIT 1) AS lead_id
       FROM projects p WHERE p.id=$1`,
      [req.params.id]
    )
    if (!project) return fail(res, 'Project not found', 404)
    if (project.lead_id !== req.session.userId) return fail(res, 'Forbidden', 403)
    if (project.status !== 'rejected') {
      return fail(res, 'Only rejected projects can be resubmitted', 400)
    }

    const FILE_BASE_URL = process.env.FILE_BASE_URL || 'http://localhost:3000/files'
    const report_url = `${FILE_BASE_URL}/${req.file.filename}`

    const [latest] = await query(
      `SELECT MAX(version_number) AS max FROM project_versions WHERE project_id=$1`,
      [req.params.id]
    )
    const nextVersion = (latest?.max || 0) + 1

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO project_versions (project_id, version_number, status, report_url)
         VALUES ($1,$2,'pending',$3)`,
        [project.id, nextVersion, report_url]
      )
      await client.query(
        `UPDATE projects SET status='pending', report_url=$1, updated_at=NOW() WHERE id=$2`,
        [report_url, project.id]
      )
    })

    const rows = await query(
      `${PROJECT_SELECT} WHERE p.id=$1 GROUP BY p.id, d.name, sv.full_name, sv.degrees`,
      [project.id]
    )
    return ok(res, serializeProject(rows[0]))
  })
)

// ── POST /api/projects/:id/change-request ─────────────────────────────────
router.post(
  '/:id/change-request',
  requireRole('student'),
  requireActive,
  uploadPdf.single('reportFile'),
  asyncHandler(async (req, res) => {
    const [project] = await query(
      `SELECT p.*, (SELECT user_id FROM project_authors WHERE project_id=p.id AND is_lead=true LIMIT 1) AS lead_id
       FROM projects p WHERE p.id=$1`,
      [req.params.id]
    )
    if (!project) return fail(res, 'Project not found', 404)
    if (project.lead_id !== req.session.userId) return fail(res, 'Forbidden', 403)
    if (project.status !== 'approved') {
      return fail(res, 'Change requests can only be made on approved projects', 400)
    }

    let fields, proposedData
    try {
      fields      = JSON.parse(req.body.fields || '[]')
      proposedData = JSON.parse(req.body.proposedData || '{}')
    } catch {
      return fail(res, 'Invalid fields or proposedData JSON', 400)
    }

    const reason = req.body.reason || ''
    if (!reason) return fail(res, 'Reason is required', 400)

    const FILE_BASE_URL = process.env.FILE_BASE_URL || 'http://localhost:3000/files'
    const report_file_url = req.file
      ? `${FILE_BASE_URL}/${req.file.filename}`
      : null

    const [cr] = await query(
      `INSERT INTO change_requests
         (project_id, student_id, fields, reason, proposed_data, report_file_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [project.id, req.session.userId, fields, reason, proposedData, report_file_url]
    )

    return ok(res, cr, 201)
  })
)

export default router
