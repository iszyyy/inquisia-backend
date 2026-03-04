import { Router } from 'express'
import { z } from 'zod'
import OpenAI from 'openai'
import { query } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireAuth, requireActive } from '../middleware/auth.js'
import { uploadPdf } from '../middleware/upload.js'
import fs from 'fs'

const router = Router()

// ── OpenAI client ─────────────────────────────────────────────
// Initialise lazily so missing key doesn't crash startup
let _openai = null
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set in environment')
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openai
}

// ── Helper: extract text from uploaded PDF ────────────────────
async function extractPdfText(filePath) {
  try {
    const pdfParse = (await import('pdf-parse')).default
    const buffer = fs.readFileSync(filePath)
    const data = await pdfParse(buffer)
    return data.text?.slice(0, 8000) || ''
  } catch {
    return ''
  }
}

// ── Helper: get AI categories list ───────────────────────────
async function getCategories() {
  const rows = await query(`SELECT name FROM ai_categories ORDER BY name`)
  return rows.map(r => r.name)
}

// ── POST /api/ai/elara ────────────────────────────────────────
router.post('/elara', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const schema = z.object({
    message: z.string().min(1).max(2000),
    history: z.array(z.object({
      role:    z.enum(['user', 'assistant']),
      content: z.string(),
    })).optional().default([]),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400)

  const { message, history } = parsed.data
  const openai = getOpenAI()

  const [stats] = await query(`
    SELECT
      (SELECT COUNT(*) FROM projects WHERE status='approved')::int  AS projects,
      (SELECT COUNT(*) FROM users WHERE role='student')::int         AS students,
      (SELECT COUNT(*) FROM users WHERE role='supervisor' AND is_verified=true)::int AS supervisors
  `)

  const systemPrompt = `You are Elara, the friendly AI assistant for Inquisia — a research project repository platform for Babcock University.

Platform stats: ${stats.projects} approved projects, ${stats.students} students, ${stats.supervisors} verified supervisors.

Your role:
- Help students find and understand research projects
- Guide students through the submission process
- Answer questions about the platform
- Provide academic writing tips
- Be encouraging and supportive

Keep responses concise (2-4 paragraphs). Use markdown where helpful.
Never fabricate specific project titles or author names.`

  const completion = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    messages:    [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10),
      { role: 'user', content: message },
    ],
    max_tokens:  600,
    temperature: 0.7,
  })

  const reply = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.'
  return res.json({ success: true, reply })
}))

// ── POST /api/ai/assistant ────────────────────────────────────
router.post('/assistant', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const schema = z.object({
    message: z.string().min(1).max(2000),
    history: z.array(z.object({
      role:    z.enum(['user', 'assistant']),
      content: z.string(),
    })).optional().default([]),
    pageContext: z.object({
      path:      z.string(),
      role:      z.string().optional(),
      projectId: z.string().optional(),
      pdfText:   z.string().optional(),
    }).optional().default({ path: '/' }),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400)

  const { message, history, pageContext } = parsed.data
  const openai = getOpenAI()

  let contextInfo = `Current page: ${pageContext.path}`
  if (pageContext.role) contextInfo += ` | User role: ${pageContext.role}`

  if (pageContext.projectId) {
    const [project] = await query(
      `SELECT title, abstract, ai_category FROM projects WHERE id=$1`,
      [pageContext.projectId]
    )
    if (project) {
      contextInfo += ` | Viewing project: "${project.title}" (${project.ai_category || 'uncategorized'})`
    }
  }

  const systemPrompt = `You are a helpful AI assistant embedded in Inquisia, a university research repository.
Context: ${contextInfo}
Be brief and helpful. Use markdown. Max 3 paragraphs.`

  const completion = await openai.chat.completions.create({
    model:    'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6),
      { role: 'user', content: message },
    ],
    max_tokens:  400,
    temperature: 0.7,
  })

  const reply = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.'
  return res.json({ success: true, reply })
}))

// ── POST /api/ai/suggest-categories ──────────────────────────
router.post('/suggest-categories', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({ query: z.string().min(3).max(500) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400)

  const categories = await getCategories()
  const openai = getOpenAI()

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role:    'system',
        content: `Given a research query, suggest the most relevant categories from this list: ${categories.join(', ')}.
Return ONLY a JSON array of 1-3 category names from the list. No explanation.`,
      },
      { role: 'user', content: parsed.data.query },
    ],
    max_tokens:  100,
    temperature: 0.3,
  })

  let suggestions = []
  try {
    const text  = completion.choices[0]?.message?.content || '[]'
    const clean = text.replace(/```json|```/g, '').trim()
    suggestions = JSON.parse(clean)
    suggestions = suggestions.filter(s => categories.includes(s))
  } catch {
    suggestions = []
  }

  return ok(res, { suggestions })
}))

// ── POST /api/ai/validate ─────────────────────────────────────
router.post(
  '/validate',
  requireAuth,
  requireActive,
  uploadPdf.single('file'),
  asyncHandler(async (req, res) => {
    const { title, abstract } = req.body
    if (!title || !abstract) return fail(res, 'Title and abstract are required', 400)
    if (title.length < 5)    return fail(res, 'Title too short', 400)
    if (abstract.length < 50) return fail(res, 'Abstract too short', 400)

    const openai = getOpenAI()
    let pdfText = ''
    if (req.file) pdfText = await extractPdfText(req.file.path)

    const categories = await getCategories()

    // Plagiarism check using pg_trgm similarity
    let similar = []
    try {
      similar = await query(`
        SELECT id, title,
          similarity(title, $1) + similarity(abstract, $2) AS score
        FROM projects
        WHERE status = 'approved'
          AND (similarity(title, $1) > 0.3 OR similarity(abstract, $2) > 0.2)
        ORDER BY score DESC
        LIMIT 1
      `, [title, abstract])
    } catch {
      // pg_trgm extension may not be installed — skip silently
    }

    const plagiarismScore   = similar.length ? Math.min(99, Math.round((similar[0].score / 2) * 100)) : 0
    const similarProjectId  = similar.length && plagiarismScore > 40 ? similar[0].id : null
    const similarityReason  = similarProjectId ? `High similarity with existing project: "${similar[0].title}"` : null

    const prompt = `Evaluate this research project submission.

Title: "${title}"
Abstract: "${abstract}"
${pdfText ? `\nPDF excerpt:\n${pdfText.slice(0, 2000)}` : ''}

Available categories: ${categories.join(', ')}

Respond ONLY with valid JSON (no markdown):
{
  "valid": true or false,
  "category": "category name from list or null",
  "tags": ["tag1","tag2","tag3"],
  "message": "brief feedback",
  "suggested_prompt": "improvement suggestion if invalid, else null"
}`

    const completion = await openai.chat.completions.create({
      model:    'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens:  300,
      temperature: 0.2,
    })

    let result = { valid: false, category: null, tags: [], message: 'Validation failed', suggested_prompt: null }
    try {
      const text  = completion.choices[0]?.message?.content || '{}'
      const clean = text.replace(/```json|```/g, '').trim()
      result      = JSON.parse(clean)
    } catch {
      result.message = 'Could not parse AI response. Please try again.'
    }

    return ok(res, {
      ...result,
      pdfText: pdfText || null,
      plagiarismData: { score: plagiarismScore, similarProjectId, similarityReason },
    })
  })
)

// ── POST /api/projects/:id/ai/summary ────────────────────────
// Mounted at /api/projects so full path is /api/projects/:id/ai/summary
router.post('/:id/ai/summary', requireAuth, asyncHandler(async (req, res) => {
  const [project] = await query(
    `SELECT id, title, abstract, ai_summary FROM projects WHERE id=$1 AND status='approved'`,
    [req.params.id]
  )
  if (!project) return fail(res, 'Project not found', 404)

  if (project.ai_summary) return res.json({ success: true, summary: project.ai_summary })

  const openai = getOpenAI()
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role:    'system',
        content: 'You are an academic research assistant. Summarize research projects concisely.',
      },
      {
        role:    'user',
        content: `Summarize in 3-4 sentences:\n\nTitle: ${project.title}\n\nAbstract: ${project.abstract}`,
      },
    ],
    max_tokens:  250,
    temperature: 0.5,
  })

  const summary = completion.choices[0]?.message?.content || 'Could not generate summary.'
  await query(`UPDATE projects SET ai_summary=$1 WHERE id=$2`, [summary, project.id])
  return res.json({ success: true, summary })
}))

// ── POST /api/projects/:id/ai/analysis ───────────────────────
router.post('/:id/ai/analysis', requireAuth, asyncHandler(async (req, res) => {
  const [project] = await query(
    `SELECT id, title, abstract, ai_analysis FROM projects WHERE id=$1 AND status='approved'`,
    [req.params.id]
  )
  if (!project) return fail(res, 'Project not found', 404)

  if (project.ai_analysis) return res.json({ success: true, analysis: project.ai_analysis })

  const openai = getOpenAI()
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role:    'system',
        content: 'You are an academic research analyst. Provide structured feedback on research projects.',
      },
      {
        role:    'user',
        content: `Analyze this project.\n\nTitle: ${project.title}\nAbstract: ${project.abstract}\n\nRespond ONLY with valid JSON:\n{\n  "limitations": ["..."],\n  "suggested_improvements": ["..."],\n  "future_research": ["..."]\n}`,
      },
    ],
    max_tokens:  500,
    temperature: 0.4,
  })

  let analysis = { limitations: [], suggested_improvements: [], future_research: [] }
  try {
    const text  = completion.choices[0]?.message?.content || '{}'
    const clean = text.replace(/```json|```/g, '').trim()
    analysis    = JSON.parse(clean)
  } catch {
    return fail(res, 'Could not generate analysis. Please try again.', 500)
  }

  await query(`UPDATE projects SET ai_analysis=$1 WHERE id=$2`, [JSON.stringify(analysis), project.id])
  return res.json({ success: true, analysis })
}))

// ── POST /api/projects/:id/ai/chat ───────────────────────────
router.post('/:id/ai/chat', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    message: z.string().min(1).max(2000),
    history: z.array(z.object({
      role:    z.enum(['user', 'assistant']),
      content: z.string(),
    })).optional().default([]),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400)

  const [project] = await query(
    `SELECT id, title, abstract, ai_category, ai_summary FROM projects WHERE id=$1`,
    [req.params.id]
  )
  if (!project) return fail(res, 'Project not found', 404)

  const { message, history } = parsed.data
  const openai = getOpenAI()

  const systemPrompt = `You are an AI assistant helping users understand a specific research project on Inquisia.

Project: "${project.title}"
Category: ${project.ai_category || 'Unknown'}
Abstract: ${project.abstract}
${project.ai_summary ? `\nSummary: ${project.ai_summary}` : ''}

Answer questions about this project. Be concise and academic. Use markdown where helpful.`

  const completion = await openai.chat.completions.create({
    model:    'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.slice(-8),
      { role: 'user', content: message },
    ],
    max_tokens:  500,
    temperature: 0.6,
  })

  const reply = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.'
  return res.json({ success: true, reply })
}))

export default router
