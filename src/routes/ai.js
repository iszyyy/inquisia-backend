import { Router } from 'express'
import { z } from 'zod'
import OpenAI from 'openai'
import { query } from '../lib/db.js'
import { ok, fail, asyncHandler } from '../lib/response.js'
import { requireAuth, requireActive } from '../middleware/auth.js'
import { uploadPdf } from '../middleware/upload.js'
import fs from 'fs'
import path from 'path'

const router = Router()

// ── OpenAI client ─────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ── Helper: extract text from uploaded PDF ────────────────────────────────
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

// ── Helper: get AI categories list ────────────────────────────────────────
async function getCategories() {
  const rows = await query(`SELECT name FROM ai_categories ORDER BY name`)
  return rows.map(r => r.name)
}

// ── POST /api/ai/elara — general AI assistant chat ────────────────────────
router.post('/elara', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const schema = z.object({
    message: z.string().min(1).max(2000),
    history: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).optional().default([]),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400)

  const { message, history } = parsed.data

  // Get some platform context
  const [stats] = await query(`
    SELECT
      (SELECT COUNT(*) FROM projects WHERE status='approved')::int  AS projects,
      (SELECT COUNT(*) FROM users WHERE role='student')::int         AS students,
      (SELECT COUNT(*) FROM users WHERE role='supervisor' AND is_verified=true)::int AS supervisors
  `)

  const systemPrompt = `You are Elara, the friendly AI assistant for Inquisia — a research project repository platform for Babcock University students and supervisors.

Platform stats: ${stats.projects} approved projects, ${stats.students} students, ${stats.supervisors} verified supervisors.

Your role:
- Help students find relevant research projects
- Guide students through the submission process
- Answer questions about the platform
- Provide academic writing tips
- Be encouraging and supportive

Keep responses concise (2-4 paragraphs max). Use markdown formatting where helpful.
Never fabricate specific project titles or author names — only reference real data if provided.`

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user', content: message },
  ]

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 600,
    temperature: 0.7,
  })

  const reply = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.'
  return res.json({ success: true, reply })
}))

// ── POST /api/ai/assistant — context-aware floating assistant ─────────────
router.post('/assistant', requireAuth, requireActive, asyncHandler(async (req, res) => {
  const schema = z.object({
    message: z.string().min(1).max(2000),
    history: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).optional().default([]),
    pageContext: z.object({
      path: z.string(),
      role: z.string().optional(),
      projectId: z.string().optional(),
      pdfText: z.string().optional(),
    }).optional().default({ path: '/' }),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400)

  const { message, history, pageContext } = parsed.data

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
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6),
      { role: 'user', content: message },
    ],
    max_tokens: 400,
    temperature: 0.7,
  })

  const reply = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.'
  return res.json({ success: true, reply })
}))

// ── POST /api/ai/suggest-categories — suggest AI category for a query ─────
router.post('/suggest-categories', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    query: z.string().min(3).max(500),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return fail(res, 'Validation failed', 400)

  const categories = await getCategories()

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Given a research query, suggest the most relevant categories from this list: ${categories.join(', ')}.
Return ONLY a JSON array of 1-3 category names from the list. No explanation.`,
      },
      { role: 'user', content: parsed.data.query },
    ],
    max_tokens: 100,
    temperature: 0.3,
  })

  let suggestions = []
  try {
    const text = completion.choices[0]?.message?.content || '[]'
    const clean = text.replace(/```json|```/g, '').trim()
    suggestions = JSON.parse(clean)
    suggestions = suggestions.filter(s => categories.includes(s))
  } catch {
    suggestions = []
  }

  return ok(res, { suggestions })
}))

// ── POST /api/ai/validate — validate title + abstract + optional PDF ───────
router.post(
  '/validate',
  requireAuth,
  requireActive,
  uploadPdf.single('file'),
  asyncHandler(async (req, res) => {
    const { title, abstract } = req.body
    if (!title || !abstract) return fail(res, 'Title and abstract are required', 400)
    if (title.length < 5) return fail(res, 'Title too short', 400)
    if (abstract.length < 50) return fail(res, 'Abstract too short', 400)

    let pdfText = ''
    if (req.file) {
      pdfText = await extractPdfText(req.file.path)
    }

    const categories = await getCategories()

    // Simple plagiarism check — find similar approved projects
    const similar = await query(`
      SELECT id, title, abstract,
        similarity(title, $1) + similarity(abstract, $2) AS score
      FROM projects
      WHERE status = 'approved'
        AND (similarity(title, $1) > 0.3 OR similarity(abstract, $2) > 0.2)
      ORDER BY score DESC
      LIMIT 1
    `, [title, abstract])

    const plagiarismScore = similar.length
      ? Math.min(99, Math.round((similar[0].score / 2) * 100))
      : 0
    const similarProjectId = similar.length && plagiarismScore > 40 ? similar[0].id : null
    const similarityReason = similarProjectId
      ? `High similarity detected with existing project: "${similar[0].title}"`
      : null

    const prompt = `Evaluate this research project submission for a university repository.

Title: "${title}"
Abstract: "${abstract}"
${pdfText ? `\nPDF excerpt:\n${pdfText.slice(0, 2000)}` : ''}

Available categories: ${categories.join(', ')}

Evaluate:
1. Does the abstract clearly describe a research project?
2. Does the content match the title?
3. Is the academic quality acceptable?
4. What is the best category from the list?

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "valid": true/false,
  "category": "category name from list or null",
  "tags": ["tag1", "tag2", "tag3"],
  "message": "brief feedback message",
  "suggested_prompt": "improvement suggestion if invalid, else null"
}`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.2,
    })

    let result = { valid: false, category: null, tags: [], message: 'Validation failed', suggested_prompt: null }
    try {
      const text = completion.choices[0]?.message?.content || '{}'
      const clean = text.replace(/```json|```/g, '').trim()
      result = JSON.parse(clean)
    } catch {
      result.message = 'Could not parse AI response. Please try again.'
    }

    return ok(res, {
      ...result,
      pdfText: pdfText || null,
      plagiarismData: {
        score: plagiarismScore,
        similarProjectId,
        similarityReason,
      },
    })
  })
)

// ── POST /api/projects/:id/ai/summary ─────────────────────────────────────
router.post('/projects/:id/ai/summary', requireAuth, asyncHandler(async (req, res) => {
  const [project] = await query(
    `SELECT id, title, abstract, ai_summary FROM projects WHERE id=$1 AND status='approved'`,
    [req.params.id]
  )
  if (!project) return fail(res, 'Project not found', 404)

  // Return cached summary if exists
  if (project.ai_summary) {
    return res.json({ success: true, summary: project.ai_summary })
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are an academic research assistant. Summarize research projects concisely for a university repository audience.',
      },
      {
        role: 'user',
        content: `Summarize this research project in 3-4 sentences for a university repository:\n\nTitle: ${project.title}\n\nAbstract: ${project.abstract}`,
      },
    ],
    max_tokens: 250,
    temperature: 0.5,
  })

  const summary = completion.choices[0]?.message?.content || 'Could not generate summary.'

  // Cache the summary
  await query(`UPDATE projects SET ai_summary=$1 WHERE id=$2`, [summary, project.id])

  return res.json({ success: true, summary })
}))

// ── POST /api/projects/:id/ai/analysis ────────────────────────────────────
router.post('/projects/:id/ai/analysis', requireAuth, asyncHandler(async (req, res) => {
  const [project] = await query(
    `SELECT id, title, abstract, ai_analysis FROM projects WHERE id=$1 AND status='approved'`,
    [req.params.id]
  )
  if (!project) return fail(res, 'Project not found', 404)

  // Return cached analysis if exists
  if (project.ai_analysis) {
    return res.json({ success: true, analysis: project.ai_analysis })
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are an academic research analyst. Analyze research projects and provide structured feedback.',
      },
      {
        role: 'user',
        content: `Analyze this research project and provide structured feedback.

Title: ${project.title}
Abstract: ${project.abstract}

Respond ONLY with valid JSON (no markdown):
{
  "limitations": ["limitation 1", "limitation 2", "limitation 3"],
  "suggested_improvements": ["improvement 1", "improvement 2", "improvement 3"],
  "future_research": ["direction 1", "direction 2", "direction 3"]
}`,
      },
    ],
    max_tokens: 500,
    temperature: 0.4,
  })

  let analysis = {
    limitations: [],
    suggested_improvements: [],
    future_research: [],
  }

  try {
    const text = completion.choices[0]?.message?.content || '{}'
    const clean = text.replace(/```json|```/g, '').trim()
    analysis = JSON.parse(clean)
  } catch {
    return fail(res, 'Could not generate analysis. Please try again.', 500)
  }

  // Cache the analysis
  await query(`UPDATE projects SET ai_analysis=$1 WHERE id=$2`, [JSON.stringify(analysis), project.id])

  return res.json({ success: true, analysis })
}))

// ── POST /api/projects/:id/ai/chat — chat about a specific project ─────────
router.post('/projects/:id/ai/chat', requireAuth, asyncHandler(async (req, res) => {
  const schema = z.object({
    message: z.string().min(1).max(2000),
    history: z.array(z.object({
      role: z.enum(['user', 'assistant']),
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

  const systemPrompt = `You are an AI assistant helping users understand a specific research project on Inquisia.

Project: "${project.title}"
Category: ${project.ai_category || 'Unknown'}
Abstract: ${project.abstract}
${project.ai_summary ? `\nSummary: ${project.ai_summary}` : ''}

Answer questions about this project specifically. Be concise and academic. Use markdown where helpful.`

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.slice(-8),
      { role: 'user', content: message },
    ],
    max_tokens: 500,
    temperature: 0.6,
  })

  const reply = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.'
  return res.json({ success: true, reply })
}))

export default router
