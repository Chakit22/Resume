import express from 'express';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { buildGraph, sanitizeHtml, isFullHtmlDocument } from './agent.js';
import type { GraphStateType } from './agent.js';
import dotenv from 'dotenv';
import * as cheerio from 'cheerio';
import {
  getDb,
  insertJob,
  updateJobStatus,
  getAllJobs,
  getJob,
  upsertSession,
  getSession,
  replaceMessages,
  getMessages,
  updateCoverLetter,
  type JobRow,
  type SessionRow,
} from './db.js';
import {
  ensureScrapedJobsTable,
  processApifyResults,
  getScrapedJobs,
  triggerSeekScrape,
  triggerLinkedInScrape,
} from './jobScraper.js';
import {
  isTelegramConfigured,
  getUpdates,
} from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_SECRET =
  process.env.SESSION_SECRET || 'resume-tailor-secret-change-in-production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Login only when NODE_ENV=production and ADMIN_PASSWORD is set (local dev skips auth).
let adminPasswordHash: string | null = null;
if (ADMIN_PASSWORD && isProduction) {
  adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
} else if (ADMIN_PASSWORD && !isProduction) {
  console.log(
    '[auth] ADMIN_PASSWORD is set but NODE_ENV is not production — login disabled (local dev).',
  );
}

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: isProduction,
      sameSite: 'lax',
    },
  }),
);

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!adminPasswordHash) return next();
  if ((req.session as any)?.authenticated) return next();
  if (req.path === '/login' || req.path.startsWith('/login')) return next();
  if (req.method === 'POST' && req.path === '/login') return next();

  // API routes: always 401 JSON — never redirect to /login HTML. Fetch follows 302 and
  // treats 200 + login HTML as a "PDF" blob, so Preview iframes show the login form.
  const apiJsonFirst =
    req.path === '/tailor' ||
    req.path === '/sessions' ||
    req.path.startsWith('/session/') ||
    req.path === '/chat' ||
    req.path.startsWith('/cover-letter') ||
    req.path === '/compile' ||
    req.path === '/compile-base' ||
    req.path.startsWith('/resume/');
  if (apiJsonFirst) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (req.headers.accept?.includes('application/json')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.redirect('/login');
}

app.use(requireAuth);

// ---------------------------------------------------------------------------
// Login / Logout
// ---------------------------------------------------------------------------

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login — Resume Tailor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #09090b; color: #e4e4e7; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 40px; width: 100%; max-width: 360px; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 24px; background: linear-gradient(135deg, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  label { display: block; font-size: 13px; font-weight: 600; color: #a1a1aa; margin-bottom: 6px; }
  input { width: 100%; padding: 12px 14px; font-size: 14px; background: #27272a; border: 1px solid #3f3f46; border-radius: 8px; color: #e4e4e7; outline: none; margin-bottom: 16px; }
  input:focus { border-color: #6366f1; }
  button { width: 100%; padding: 12px; font-size: 14px; font-weight: 700; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; border-radius: 8px; cursor: pointer; }
  button:hover { opacity: 0.95; }
  .error { color: #f87171; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
<div class="card">
  <h1>Resume Tailor</h1>
  <form method="POST" action="/login">
    <div id="error" class="error"></div>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" placeholder="Enter password" required autofocus autocomplete="on">
    <button type="submit">Log in</button>
  </form>
</div>
</body>
</html>`;

app.get('/login', (_req, res) => {
  if (!adminPasswordHash) {
    return res.send(
      LOGIN_HTML.replace(
        '<form method="POST" action="/login">',
        '<p style="color:#a1a1aa;margin-bottom:16px;">Login is disabled. Set <code>ADMIN_PASSWORD</code> in .env to enable.</p><p style="margin-top:12px;"><a href="/" style="color:#6366f1;">Go to app</a></p><form method="POST" action="/login" style="display:none">',
      ),
    );
  }
  if ((_req.session as any)?.authenticated) return res.redirect('/');
  res.send(LOGIN_HTML);
});

app.post('/login', async (req, res) => {
  if (!adminPasswordHash) return res.redirect('/');
  const password =
    typeof req.body.password === 'string' ? req.body.password : '';
  const ok = await bcrypt.compare(password, adminPasswordHash);
  if (ok) {
    (req.session as any).authenticated = true;
    return res.redirect('/');
  }
  res
    .status(401)
    .send(
      LOGIN_HTML.replace(
        '<div id="error" class="error"></div>',
        '<div id="error" class="error">Invalid password.</div>',
      ),
    );
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/login');
});
/** Path to base HTML resume; override with BASE_RESUME_PATH (absolute or relative to process.cwd()) for Docker mounts. */
function resolveBaseResumePath(): string {
  const fromEnv = process.env.BASE_RESUME_PATH?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.resolve(__dirname, '../resumes/base-resume.html');
}

const RESUME_PATH = resolveBaseResumePath();
const OUTPUT_DIR = path.resolve(__dirname, '../resumes/output');

const sessions: Map<string, GraphStateType> = new Map();

// ---------------------------------------------------------------------------
// FIFO Job Queue — each submitted job sits here until processed
// ---------------------------------------------------------------------------

interface JobEntry {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'error';
  label: string;
  createdAt: number;
  jd: string;
  error?: string;
}

const jobQueue: JobEntry[] = [];
let processing = false;

function serializeMessages(
  messages: any[],
): Array<{ type: string; content: string }> {
  return messages.map((m: any) => ({
    type: typeof m._getType === 'function' ? m._getType() : 'unknown',
    content: typeof m.content === 'string' ? m.content : String(m.content),
  }));
}

function processQueue() {
  if (processing) return;
  const next = jobQueue.find((j) => j.status === 'queued');
  if (!next) return;

  processing = true;
  next.status = 'processing';
  updateJobStatus(next.id, 'processing');
  console.log(`🚀 [queue] Processing job ${next.id} — "${next.label}"`);

  (async () => {
    try {
      const baseResume = loadBaseResume();
      const graph = buildGraph();
      const result = await graph.invoke({
        messages: [new HumanMessage(next.jd)],
        baseResume,
      });

      result.baseResume = loadBaseResume();
      sessions.set(next.id, result);
      next.status = 'done';

      let ats: any;
      try {
        ats =
          typeof result.atsAnalysis === 'string'
            ? JSON.parse(result.atsAnalysis)
            : result.atsAnalysis;
      } catch {
        ats = {};
      }
      if (ats.jobTitle)
        next.label = ats.jobTitle + (ats.company ? ` at ${ats.company}` : '');

      updateJobStatus(next.id, 'done', next.label);
      persistSession(next.id, result);

      console.log(`✅ [queue] Job ${next.id} done — "${next.label}"`);
    } catch (err: any) {
      console.error(`❌ [queue] Job ${next.id} failed:`, err.message);
      next.status = 'error';
      next.error = err.message;
      updateJobStatus(next.id, 'error', undefined, err.message);
    } finally {
      processing = false;
      processQueue();
    }
  })();
}

function persistSession(
  id: string,
  state: GraphStateType,
  coverLetter?: string,
) {
  const existing = getSession(id);
  const baseForDb = currentBaseResumeOr(state.baseResume);
  upsertSession({
    id,
    baseResume: baseForDb,
    parsedJD: state.parsedJD,
    atsAnalysis: state.atsAnalysis,
    tailoredResume: state.tailoredResume,
    coverLetter: coverLetter ?? existing?.cover_letter ?? '',
    pageCount: state.pageCount,
    trimAttempts: state.trimAttempts,
  });
  replaceMessages(id, serializeMessages(state.messages));
}

function hydrateFromDb() {
  console.log('📂 [db] Hydrating from SQLite...');
  getDb();

  const jobs = getAllJobs();
  for (const row of jobs) {
    const status = (
      row.status === 'processing' ? 'queued' : row.status
    ) as JobEntry['status'];
    if (status === 'processing') {
      updateJobStatus(row.id, 'queued');
    }
    jobQueue.push({
      id: row.id,
      status,
      label: row.label,
      createdAt: row.created_at,
      jd: row.jd,
      error: row.error ?? undefined,
    });

    if (row.status === 'done') {
      const sRow = getSession(row.id);
      if (sRow) {
        const msgRows = getMessages(row.id);
        const messages = msgRows.map((m) => {
          if (m.type === 'human') return new HumanMessage(m.content);
          return new AIMessage(m.content);
        });
        const sess: any = {
          messages,
          baseResume: currentBaseResumeOr(sRow.base_resume),
          parsedJD: sRow.parsed_jd,
          atsAnalysis: sRow.ats_analysis,
          tailoredResume: sRow.tailored_resume,
          pageCount: sRow.page_count,
          trimAttempts: sRow.trim_attempts,
        };
        const sessRow = sRow as { cover_letter?: string };
        if (sessRow.cover_letter) sess.coverLetter = sessRow.cover_letter;
        sessions.set(row.id, sess as GraphStateType);
      }
    }
  }

  const queued = jobQueue.filter((j) => j.status === 'queued').length;
  const done = jobQueue.filter((j) => j.status === 'done').length;
  console.log(
    `📂 [db] Loaded ${jobs.length} jobs (${done} done, ${queued} queued)`,
  );

  if (queued > 0) processQueue();
}

function loadBaseResume(): string {
  if (!fs.existsSync(RESUME_PATH)) {
    throw new Error(
      `Base resume not found at ${RESUME_PATH}. ` +
        `Place your HTML resume at resume-tailor/backend/resumes/base-resume.html`,
    );
  }
  return fs.readFileSync(RESUME_PATH, 'utf-8');
}

/** Always use the latest file; fall back to stored snapshot only if the file is missing. */
function currentBaseResumeOr(fallback: string): string {
  try {
    return loadBaseResume();
  } catch {
    return fallback;
  }
}

/** Re-sync session.baseResume from disk so nothing uses a stale snapshot. */
function refreshSessionBaseInPlace(session: GraphStateType): void {
  session.baseResume = currentBaseResumeOr(session.baseResume);
}

// ---------------------------------------------------------------------------
// URL scraping: fetch a job page and extract the description text
// ---------------------------------------------------------------------------

async function scrapeJobDescription(url: string): Promise<string> {
  console.log(`🌐 [scrape] Fetching: ${url}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch URL (${res.status} ${res.statusText})`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Remove noise
  $('script, style, nav, header, footer, aside, noscript, iframe').remove();

  // Try specific selectors first (ordered by specificity)
  const selectors = [
    // Indeed
    '#jobDescriptionText',
    '.jobsearch-JobComponent-description',
    '.jobsearch-jobDescriptionText',
    // LinkedIn (rarely works without JS, but try)
    '.jobs-description__content',
    '.jobs-box__html-content',
    // Glassdoor
    '.jobDescriptionContent',
    '[class*="JobDescription"]',
    // Greenhouse
    '#content .body',
    '.job-post',
    // Lever
    '.posting-page .content',
    '[class*="posting-description"]',
    // Workday
    '[data-automation-id="jobPostingDescription"]',
    // Ashby
    '[class*="jobDescription"]',
    // Dice
    '[data-testid="jobDescription"]',
    // Generic patterns
    '#job-description',
    '#jobDescription',
    '#job_description',
    '.job-description',
    '.job_description',
    '.jobDescription',
    '[class*="job-description"]',
    '[class*="job_description"]',
    '[id*="job-description"]',
    '[id*="jobDescription"]',
    '[data-testid*="description"]',
    '[role="article"]',
    '.posting-page',
    '.job-details',
    '.job-posting',
    '.job-content',
    '.description__text',
  ];

  for (const sel of selectors) {
    const el = $(sel);
    const text = el.text()?.trim();
    if (text && text.length > 150) {
      console.log(
        `✅ [scrape] Found JD via selector: ${sel} (${text.length} chars)`,
      );
      return text;
    }
  }

  // Fallback: main/article containers
  for (const tag of ['main', 'article', "[role='main']"]) {
    const text = $(tag).text()?.trim();
    if (text && text.length > 300 && text.length < 20000) {
      console.log(
        `✅ [scrape] Using <${tag}> container (${text.length} chars)`,
      );
      return text;
    }
  }

  // Last resort: largest text block
  let best = '';
  $('div, section').each((_, el) => {
    const text = $(el).text()?.trim() || '';
    if (text.length > best.length && text.length > 300 && text.length < 20000) {
      best = text;
    }
  });

  if (best.length > 300) {
    console.log(`✅ [scrape] Fallback largest block (${best.length} chars)`);
    return best;
  }

  throw new Error(
    'Could not extract a job description from this URL. The page may require JavaScript to render. Try pasting the JD text directly.',
  );
}

// ---------------------------------------------------------------------------
// POST /tailor  (non-blocking — enqueues and returns immediately)
// Body: { jd?: string, url?: string }
// ---------------------------------------------------------------------------

app.post('/tailor', async (req, res) => {
  try {
    let { jd, url } = req.body;

    if (url && typeof url === 'string') {
      jd = await scrapeJobDescription(url.trim());
    }

    if (!jd || typeof jd !== 'string') {
      res
        .status(400)
        .json({ error: "Provide either a 'url' to scrape or 'jd' text." });
      return;
    }

    const id = crypto.randomUUID();
    const label =
      url && typeof url === 'string'
        ? url.replace(/^https?:\/\//, '').slice(0, 60)
        : jd.slice(0, 50) + '...';

    const job: JobEntry = {
      id,
      status: 'queued',
      label,
      createdAt: Date.now(),
      jd,
    };
    jobQueue.push(job);
    insertJob(job);

    console.log(
      `📋 [tailor] Job ${id} queued — ${jobQueue.filter((j) => j.status === 'queued').length} in queue`,
    );

    processQueue();

    res.json({ sessionId: id, status: job.status, label: job.label });
  } catch (err: any) {
    console.error('❌ Error in /tailor:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /sessions — list all jobs for the sidebar
// ---------------------------------------------------------------------------

app.get('/sessions', (_req, res) => {
  const list = jobQueue.map((j) => ({
    id: j.id,
    status: j.status,
    label: j.label,
    createdAt: j.createdAt,
    error: j.error,
  }));
  res.json(list);
});

// ---------------------------------------------------------------------------
// GET /session/:id — full session data for a completed job
// ---------------------------------------------------------------------------

app.get('/session/:id', (req, res) => {
  const job = jobQueue.find((j) => j.id === req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  if (job.status !== 'done') {
    res.json({ status: job.status, label: job.label, error: job.error });
    return;
  }

  const session = sessions.get(job.id);
  if (!session) {
    res.status(500).json({ error: 'Session data missing' });
    return;
  }

  refreshSessionBaseInPlace(session);

  let atsAnalysis: any;
  try {
    atsAnalysis =
      typeof session.atsAnalysis === 'string'
        ? JSON.parse(session.atsAnalysis)
        : session.atsAnalysis;
  } catch {
    atsAnalysis = { score: 0, matched: [], missing: [], jobTitle: 'Unknown' };
  }

  const messages = session.messages
    .filter((m: any) => {
      const content = typeof m.content === 'string' ? m.content : '';
      return !content.startsWith('[System]');
    })
    .map((m: any) => ({
      role: m._getType() === 'human' ? 'user' : 'assistant',
      content: m.content,
    }));

  const sRow = getSession(job.id);
  const coverLetter = sRow?.cover_letter ?? (session as any).coverLetter ?? '';

  res.json({
    status: 'done',
    label: job.label,
    atsAnalysis,
    tailoredResume: session.tailoredResume,
    baseResume: currentBaseResumeOr(session.baseResume),
    parsedJD: session.parsedJD,
    coverLetter,
    messages,
  });
});

// ---------------------------------------------------------------------------
// POST /chat
// ---------------------------------------------------------------------------

app.post('/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      res.status(400).json({ error: "Missing 'sessionId' or 'message'" });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res
        .status(404)
        .json({ error: 'Session not found. Start with /tailor first.' });
      return;
    }

    refreshSessionBaseInPlace(session);

    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    const { SystemMessage, AIMessage } =
      await import('@langchain/core/messages');
    const { CHAT_SYSTEM_PROMPT } = await import('./prompts.js');

    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-2.5-flash-lite',
      temperature: 0.3,
      maxOutputTokens: 8192,
    });

    const updatedMessages = [...session.messages, new HumanMessage(message)];

    const originalBase = session.baseResume;
    const systemContent =
      CHAT_SYSTEM_PROMPT +
      `\n\n--- Original Resume ---\n${originalBase}\n\n` +
      `--- Tailored Resume ---\n${session.tailoredResume}\n\n` +
      `--- ATS Analysis ---\n${session.atsAnalysis}\n\n` +
      `--- Parsed JD ---\n${session.parsedJD}`;

    const conversation = updatedMessages.filter((m) => {
      const c = typeof m.content === 'string' ? m.content : '';
      return !c.startsWith('[System]');
    });
    if (conversation.length > 0 && !(conversation[0] instanceof HumanMessage)) {
      conversation.unshift(
        new HumanMessage('Please summarize what you changed in my resume.'),
      );
    }

    const contextMessages = [new SystemMessage(systemContent), ...conversation];

    const response = await llm.invoke(contextMessages);
    const content =
      typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((c: any) => c.text || String(c)).join('')
          : String(response.content);

    const aiMsg = new AIMessage(content);
    const allMessages = [...updatedMessages, aiMsg];

    const htmlMatch = content.match(/```html\n([\s\S]*?)```/);
    let updatedResume = session.tailoredResume;
    let resumeUpdated = false;
    let resumeUpdateRejected: string | undefined;
    if (htmlMatch) {
      const extracted = htmlMatch[1].trim();
      // Reject if LLM output looks like a generic template (would overwrite user's real resume)
      const looksLikeTemplate =
        /\b(Your Name|Company Name|University Name|you@example\.com|Location, Country)\b/i.test(
          extracted,
        );
      if (!looksLikeTemplate && extracted.length > 100) {
        if (isFullHtmlDocument(extracted)) {
          updatedResume = extracted;
          resumeUpdated = true;
        } else {
          resumeUpdateRejected =
            'HTML block was skipped: it must be the **complete** resume (from <!DOCTYPE html> through </html>), not a single section. Ask again for the full file in one ```html block.';
        }
      }
    }

    const updatedSession = {
      ...session,
      messages: allMessages,
      tailoredResume: updatedResume,
      baseResume: originalBase,
    };
    sessions.set(sessionId, updatedSession);
    persistSession(sessionId, updatedSession);

    res.json({
      role: 'assistant',
      content,
      tailoredResume: updatedResume,
      resumeUpdated,
      ...(resumeUpdateRejected ? { resumeUpdateRejected } : {}),
    });
  } catch (err: any) {
    console.error('Error in /chat:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /cover-letter — generate cover letter for a session
// ---------------------------------------------------------------------------

app.post('/cover-letter', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found. Run /tailor first.' });
      return;
    }

    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    const { SystemMessage, HumanMessage } =
      await import('@langchain/core/messages');
    const { COVER_LETTER_PROMPT } = await import('./prompts.js');

    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-2.5-flash-lite',
      temperature: 0.5,
      maxOutputTokens: 2048,
    });

    const prompt = `--- Tailored Resume (LaTeX) ---
${session.tailoredResume}

--- Parsed Job Description ---
${session.parsedJD}

--- ATS Analysis ---
${session.atsAnalysis}

Write the cover letter.`;

    const response = await llm.invoke([
      new SystemMessage(COVER_LETTER_PROMPT),
      new HumanMessage(prompt),
    ]);

    const content =
      typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((c: any) => c.text || String(c)).join('')
          : String(response.content);

    const coverLetter = content.trim();
    (session as any).coverLetter = coverLetter;
    updateCoverLetter(sessionId, coverLetter);

    res.json({ coverLetter });
  } catch (err: any) {
    console.error('Error in /cover-letter:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /cover-letter/save — save edited cover letter
// ---------------------------------------------------------------------------

app.post('/cover-letter/save', (req, res) => {
  try {
    const { sessionId, coverLetter } = req.body;
    if (!sessionId || typeof coverLetter !== 'string') {
      res.status(400).json({ error: 'Missing sessionId or coverLetter' });
      return;
    }

    const session = sessions.get(sessionId);
    const sRow = getSession(sessionId);
    if (!session && !sRow) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (session) (session as any).coverLetter = coverLetter;
    updateCoverLetter(sessionId, coverLetter);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error in /cover-letter/save:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /cover-letter/download/pdf — return cover letter as PDF
// ---------------------------------------------------------------------------

function getCoverLetterAndFilename(
  sessionId: string,
): { coverLetter: string; filename: string } | null {
  const session = sessions.get(sessionId);
  const sRow = getSession(sessionId);
  const job = jobQueue.find((j) => j.id === sessionId) || getJob(sessionId);

  const coverLetter = sRow?.cover_letter ?? (session as any)?.coverLetter ?? '';
  if (!coverLetter) return null;

  let name = '';
  try {
    const ats = sRow?.ats_analysis
      ? typeof sRow.ats_analysis === 'string'
        ? JSON.parse(sRow.ats_analysis)
        : sRow.ats_analysis
      : (session as any)?.atsAnalysis;
    name = (ats?.company || ats?.jobTitle || job?.label || 'cover-letter')
      .replace(/[^a-zA-Z0-9\s\-_]/g, '')
      .replace(/\s+/g, '-')
      .trim()
      .slice(0, 60);
  } catch {
    name = (job?.label || 'cover-letter')
      .replace(/[^a-zA-Z0-9\s\-_]/g, '')
      .replace(/\s+/g, '-')
      .trim()
      .slice(0, 60);
  }
  const filename = name ? `${name}-cover-letter` : 'cover-letter';
  return { coverLetter, filename };
}

app.post('/cover-letter/download/pdf', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId' });
      return;
    }

    const data = getCoverLetterAndFilename(sessionId);
    if (!data) {
      res
        .status(404)
        .json({ error: 'Cover letter not found. Generate it first.' });
      return;
    }

    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument({ margin: 72 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    const done = new Promise<void>((resolve, reject) => {
      doc.on('end', () => resolve());
      doc.on('error', reject);
    });

    doc.fontSize(12);
    const lines = data.coverLetter.split(/\n/);
    for (const line of lines) {
      doc.text(line || ' ', { lineGap: 4 });
    }
    doc.end();
    await done;

    const buffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${data.filename}.pdf"`,
    );
    res.setHeader('X-Suggested-Filename', `${data.filename}.pdf`);
    res.setHeader('Access-Control-Expose-Headers', 'X-Suggested-Filename');
    res.send(buffer);
  } catch (err: any) {
    console.error('Error in /cover-letter/download/pdf:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /cover-letter/download/docx — return cover letter as DOCX
// ---------------------------------------------------------------------------

app.post('/cover-letter/download/docx', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId' });
      return;
    }

    const data = getCoverLetterAndFilename(sessionId);
    if (!data) {
      res
        .status(404)
        .json({ error: 'Cover letter not found. Generate it first.' });
      return;
    }

    const { Document, Packer, Paragraph, TextRun } = await import('docx');

    const paragraphs = data.coverLetter.split(/\n/).map(
      (line) =>
        new Paragraph({
          children: [new TextRun(line || ' ')],
          spacing: { after: 120 },
        }),
    );

    const doc = new Document({
      sections: [{ children: paragraphs }],
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${data.filename}.docx"`,
    );
    res.setHeader('X-Suggested-Filename', `${data.filename}.docx`);
    res.setHeader('Access-Control-Expose-Headers', 'X-Suggested-Filename');
    res.send(buffer);
  } catch (err: any) {
    console.error('Error in /cover-letter/download/docx:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /compile-base — return base resume HTML (client renders PDF via html2pdf)
// ---------------------------------------------------------------------------

app.post('/compile-base', async (req, res) => {
  try {
    const baseResume = loadBaseResume();
    const clean = sanitizeHtml(baseResume);
    res.json({ html: clean });
  } catch (err: any) {
    console.error('Error in /compile-base:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /compile
// ---------------------------------------------------------------------------

app.post('/compile', async (req, res) => {
  try {
    const { sessionId, tailoredResume: bodyHtml } = req.body;
    let htmlToCompile: string | null = null;
    const session = sessions.get(sessionId);
    if (session) {
      htmlToCompile = session.tailoredResume;
    } else if (bodyHtml && typeof bodyHtml === 'string') {
      htmlToCompile = bodyHtml;
    }
    if (!htmlToCompile) {
      res.status(404).json({ error: 'Session not found. Run /tailor first.' });
      return;
    }

    if (!isFullHtmlDocument(htmlToCompile)) {
      res.status(400).json({
        error:
          'Tailored resume is not a complete HTML document (missing <!DOCTYPE html> or </html>).',
        details:
          'Compile needs the full file: <!DOCTYPE html> … </html>. ' +
          'If Chat replaced your resume, ask the assistant to paste the **entire** resume in one ```html block, not just one section. Re-run Tailor to restore a full document.',
      });
      return;
    }

    const clean = sanitizeHtml(htmlToCompile);

    let downloadName = 'tailored-resume';
    if (sessionId) {
      const job = jobQueue.find((j: any) => j.id === sessionId);
      let name = '';
      try {
        const ats =
          typeof session?.atsAnalysis === 'string'
            ? JSON.parse(session.atsAnalysis)
            : session?.atsAnalysis;
        name = ats?.company || ats?.jobTitle || '';
      } catch {}
      if (!name && job?.label) {
        name = job.label.includes(' at ')
          ? job.label.split(' at ')[1]
          : job.label;
      }
      const safe = String(name || '')
        .replace(/[^a-zA-Z0-9\s\-_]/g, '')
        .replace(/\s+/g, '-')
        .trim()
        .slice(0, 60);
      if (safe) downloadName = safe + '-resume';
    }

    res.json({ html: clean, filename: downloadName });
  } catch (err: any) {
    console.error('Error in /compile:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Apify Webhook — receives scraped job results
// ---------------------------------------------------------------------------

app.post('/api/apify-webhook', async (req, res) => {
  try {
    const { source, results } = req.body;

    if (!results || !Array.isArray(results)) {
      // Apify sends dataset ID — fetch results from Apify API
      const datasetId = req.body?.resource?.defaultDatasetId;
      const apifyToken = process.env.APIFY_API_TOKEN?.trim();
      if (datasetId && apifyToken) {
        const apiRes = await fetch(
          `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`,
        );
        const items = (await apiRes.json()) as any[];
        const appBaseUrl = `${req.protocol}://${req.get('host')}`;
        const newCount = await processApifyResults(items, source || 'apify', appBaseUrl);
        res.json({ ok: true, newJobs: newCount });
        return;
      }
      res.status(400).json({ error: 'No results or datasetId provided' });
      return;
    }

    const appBaseUrl = `${req.protocol}://${req.get('host')}`;
    const newCount = await processApifyResults(results, source || 'apify', appBaseUrl);
    res.json({ ok: true, newJobs: newCount });
  } catch (err: any) {
    console.error('[apify-webhook] Error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------------------------------------------------------
// GET /api/scraped-jobs — list scraped jobs
// ---------------------------------------------------------------------------

app.get('/api/scraped-jobs', (_req, res) => {
  try {
    const jobs = getScrapedJobs(100);
    res.json(jobs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/trigger-scrape — manually trigger a scrape
// ---------------------------------------------------------------------------

app.post('/api/trigger-scrape', async (req, res) => {
  try {
    const { source } = req.body || {};
    if (source === 'linkedin') {
      await triggerLinkedInScrape();
    } else {
      await triggerSeekScrape();
    }
    res.json({ ok: true, message: `Scrape triggered for ${source || 'seek'}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/telegram-chat-id — helper to find your chat ID
// ---------------------------------------------------------------------------

app.get('/api/telegram-chat-id', async (_req, res) => {
  try {
    const data = await getUpdates();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /resume/:sessionId
// ---------------------------------------------------------------------------

app.get('/resume/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ tailoredResume: session.tailoredResume });
});

// ---------------------------------------------------------------------------
// GET / — Web UI
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => {
  const logoutBtn = adminPasswordHash
    ? '<form method="POST" action="/logout"><button type="submit" class="logout-btn">Log out</button></form>'
    : '';
  res.send(WEB_UI_HTML.replace('{{LOGOUT_BTN}}', logoutBtn));
});

const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Resume Tailor</title>
<style>
  :root {
    --bg: #09090b; --bg-card: #18181b; --bg-input: #27272a;
    --sidebar-bg: #111113; --sidebar-w: 280px;
    --border: #27272a; --border-focus: #6366f1;
    --text: #e4e4e7; --text-muted: #a1a1aa; --text-dim: #71717a;
    --accent: #6366f1; --accent-hover: #4f46e5;
    --green: #34d399; --green-bg: rgba(52,211,153,0.12);
    --red: #f87171; --red-bg: rgba(248,113,113,0.12);
    --yellow: #fbbf24; --yellow-bg: rgba(251,191,36,0.12);
    --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; }

  /* ── Sidebar ── */
  .sidebar { width: var(--sidebar-w); min-width: var(--sidebar-w); height: 100vh; background: var(--sidebar-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: fixed; left: 0; top: 0; z-index: 1000; transition: transform 0.25s ease, box-shadow 0.25s ease; }
  .sidebar-header { padding: 20px 16px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .sidebar-header-inner { flex: 1; min-width: 0; }
  .sidebar-header h2 { font-size: 16px; font-weight: 800; background: linear-gradient(135deg, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 12px; }
  .sidebar-close { display: none; width: 36px; height: 36px; flex-shrink: 0; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text); cursor: pointer; align-items: center; justify-content: center; font-size: 20px; line-height: 1; }
  .sidebar-close:hover { background: var(--border); }
  .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999; opacity: 0; transition: opacity 0.25s ease; pointer-events: none; }
  .sidebar-overlay.visible { pointer-events: auto; opacity: 1; }
  .main-header { display: none; align-items: center; gap: 12px; padding: 12px 16px; background: var(--sidebar-bg); border-bottom: 1px solid var(--border); }
  .menu-toggle { width: 40px; height: 40px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; }
  .menu-toggle:hover { background: var(--border); }
  .new-job-btn { width: 100%; padding: 10px; font-size: 13px; font-weight: 700; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
  .new-job-btn:hover { box-shadow: 0 2px 12px rgba(99,102,241,0.4); }
  .sidebar-footer { padding: 12px 16px; border-top: 1px solid var(--border); margin-top: auto; }
  .logout-btn { width: 100%; padding: 10px; font-size: 13px; font-weight: 600; background: transparent; color: var(--text-dim); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
  .logout-btn:hover { background: rgba(255,255,255,0.05); color: var(--text); }
  .thread-list { flex: 1; overflow-y: auto; padding: 8px 0; }
  .thread-item { padding: 12px 16px; cursor: pointer; border-left: 3px solid transparent; transition: all 0.12s; display: flex; align-items: center; gap: 10px; }
  .thread-item:hover { background: rgba(255,255,255,0.03); }
  .thread-item.active { background: rgba(99,102,241,0.1); border-left-color: var(--accent); }
  .thread-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .thread-dot.queued { background: var(--yellow); }
  .thread-dot.processing { background: var(--yellow); animation: pulse 1.2s ease-in-out infinite; }
  .thread-dot.done { background: var(--green); }
  .thread-dot.error { background: var(--red); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .thread-info { flex: 1; min-width: 0; }
  .thread-label { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .thread-status { font-size: 11px; color: var(--text-dim); margin-top: 2px; text-transform: capitalize; }

  /* ── Main content ── */
  .main { margin-left: var(--sidebar-w); flex: 1; min-height: 100vh; }
  .main-inner { max-width: 860px; margin: 0 auto; padding: 40px 32px; }

  /* Input phase */
  .input-mode-toggle { display: flex; gap: 0; margin-bottom: 16px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); width: fit-content; }
  .input-mode-toggle button { padding: 8px 20px; font-size: 13px; font-weight: 600; background: transparent; color: var(--text-muted); border: none; cursor: pointer; transition: all 0.15s; }
  .input-mode-toggle button.active { background: var(--accent); color: #fff; }
  .url-input { width: 100%; padding: 14px 16px; font-size: 14px; font-family: inherit; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); outline: none; }
  .url-input:focus { border-color: var(--border-focus); }
  .url-input::placeholder { color: #52525b; }
  .jd-textarea { width: 100%; min-height: 200px; padding: 16px; font-size: 14px; font-family: inherit; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); resize: vertical; outline: none; line-height: 1.6; }
  .jd-textarea:focus { border-color: var(--border-focus); }
  .jd-textarea::placeholder { color: #52525b; }
  .tailor-btn { margin-top: 14px; padding: 13px 36px; font-size: 14px; font-weight: 700; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; border-radius: 10px; cursor: pointer; transition: all 0.2s; letter-spacing: 0.3px; }
  .tailor-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(99,102,241,0.4); }
  .tailor-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }

  /* Loading */
  #loading { display: none; padding: 60px 20px; text-align: center; }
  .spinner { display: inline-block; width: 36px; height: 36px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #loading p { margin-top: 14px; color: var(--text-muted); font-size: 14px; }

  /* Results phase */
  #results-phase { display: none; }

  /* ATS card */
  .ats-card { padding: 24px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 20px; }
  .ats-header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 16px; }
  .ats-score { font-size: 52px; font-weight: 900; background: linear-gradient(135deg, #6366f1, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; line-height: 1; }
  .ats-score-label { font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); font-weight: 600; }
  .ats-job-title { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 16px; }
  .keywords-row { display: flex; gap: 24px; flex-wrap: wrap; }
  .keywords-group h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); margin-bottom: 6px; font-weight: 600; }
  .tag { display: inline-block; padding: 3px 10px; margin: 2px; border-radius: 6px; font-size: 12px; font-weight: 500; }
  .tag-matched { background: var(--green-bg); color: var(--green); }
  .tag-missing { background: var(--red-bg); color: var(--red); }

  /* Chat */
  .chat-box { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 16px; }
  .chat-header { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600; color: var(--text-muted); }
  .messages { max-height: 360px; overflow-y: auto; padding: 16px; min-height: 60px; }
  .msg { max-width: 85%; padding: 12px 16px; margin-bottom: 10px; border-radius: 14px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { background: var(--accent); color: #fff; margin-left: auto; border-bottom-right-radius: 4px; }
  .msg.assistant { background: var(--bg-input); color: var(--text); border-bottom-left-radius: 4px; }
  .chat-input { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
  .chat-input input { flex: 1; padding: 10px 14px; font-size: 13px; background: var(--bg-input); border: 1px solid #3f3f46; border-radius: 8px; color: var(--text); outline: none; font-family: inherit; }
  .chat-input input:focus { border-color: var(--accent); }
  .chat-input button { padding: 10px 20px; font-size: 13px; font-weight: 600; background: var(--accent); color: #fff; border: none; border-radius: 8px; cursor: pointer; }
  .chat-input button:disabled { opacity: 0.5; }

  /* Action buttons */
  .actions { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .actions button { flex: 1; padding: 13px; font-size: 13px; font-weight: 700; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-card); color: var(--text); cursor: pointer; transition: all 0.15s; letter-spacing: 0.2px; min-width: 120px; }
  .actions button:hover { background: var(--bg-input); }
  .btn-approve { background: #059669 !important; border-color: #059669 !important; color: #fff !important; }
  .btn-approve:hover { background: #047857 !important; }
  .btn-compile { background: var(--accent) !important; border-color: var(--accent) !important; color: #fff !important; display: none; }
  .btn-compile:hover { background: var(--accent-hover) !important; }
  .btn-compile:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-preview { background: #0ea5e9 !important; border-color: #0ea5e9 !important; color: #fff !important; }
  .btn-preview:hover { background: #0284c7 !important; }
  .btn-preview:disabled { opacity: 0.5; cursor: not-allowed; }

  /* LaTeX preview */
  .latex-preview { max-height: 300px; overflow-y: auto; padding: 16px; background: #0f0f11; border: 1px solid var(--border); border-radius: 10px; font-family: "SF Mono", Monaco, "Cascadia Code", monospace; font-size: 12px; line-height: 1.6; color: var(--text-muted); white-space: pre-wrap; display: none; margin-bottom: 16px; }

  /* Three-panel comparison preview */
  .preview-comparison { display: none; margin-bottom: 16px; position: relative; margin-left: calc(-50vw + 50% + var(--sidebar-w)/2); width: calc(100vw - var(--sidebar-w)); padding: 0 20px; }
  .preview-comparison .preview-close { position: absolute; top: 12px; right: 28px; background: rgba(0,0,0,0.75); color: #fff; border: none; border-radius: 6px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; z-index: 3; }
  .preview-comparison .preview-close:hover { background: rgba(0,0,0,0.95); }
  .preview-panels { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .preview-panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; overflow: visible; display: flex; flex-direction: column; }
  .preview-panel-title { padding: 10px 14px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); border-bottom: 1px solid var(--border); text-align: center; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; user-select: none; }
  .preview-panel-title:active { background: rgba(255,255,255,0.03); }
  .preview-panel-title .collapse-arrow { transition: transform 0.2s ease; font-size: 10px; }
  .preview-panel.collapsed .collapse-arrow { transform: rotate(-90deg); }
  .preview-panel.collapsed iframe,
  .preview-panel.collapsed .preview-jd,
  .preview-panel.collapsed .resize-handle { display: none !important; }
  .preview-panel.collapsed .preview-panel-title { border-bottom: none; }
  .preview-panel .resize-handle { display: none; height: 28px; cursor: ns-resize; align-items: center; justify-content: center; background: var(--bg-card); border-top: 1px solid var(--border); flex-shrink: 0; touch-action: none; -webkit-touch-callout: none; }
  .preview-panel .resize-handle::after { content: ''; width: 40px; height: 4px; border-radius: 2px; background: var(--text-dim); pointer-events: none; }
  .preview-panel.resizing iframe { pointer-events: none; }
  .preview-panel iframe { width: 100%; height: 700px; border: none; background: #fff; flex: 1; }
  .preview-jd { padding: 16px; font-size: 13px; line-height: 1.7; color: var(--text-muted); overflow-y: auto; height: 700px; white-space: pre-wrap; word-wrap: break-word; }

  /* Cover letter preview */
  .cover-letter-preview { display: none; margin-bottom: 16px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; position: relative; }
  .cover-letter-preview .preview-close { position: absolute; top: 12px; right: 16px; background: rgba(0,0,0,0.75); color: #fff; border: none; border-radius: 6px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; z-index: 2; }
  .cover-letter-preview .preview-close:hover { background: rgba(0,0,0,0.95); }
  .cover-letter-preview .cover-letter-toolbar { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: rgba(0,0,0,0.2); }
  .cover-letter-preview .cover-letter-toolbar button { padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: 6px; cursor: pointer; border: none; }
  .cover-letter-preview .cover-letter-save { background: var(--green); color: #000; }
  .cover-letter-preview .cover-letter-save:hover { filter: brightness(1.1); }
  .cover-letter-preview .cover-letter-save.saved { background: var(--text-dim); color: var(--text); }
  .cover-letter-content { display: block; width: 100%; min-height: 400px; padding: 24px 48px 48px; font-size: 14px; line-height: 1.8; color: var(--text); background: var(--bg-card); border: none; resize: vertical; font-family: inherit; box-sizing: border-box; }
  .cover-letter-content:focus { outline: none; }
  .btn-cover { background: #7c3aed !important; border-color: #7c3aed !important; color: #fff !important; }
  .btn-cover-save { background: #059669 !important; border-color: #059669 !important; }
  .btn-cover:hover { background: #6d28d9 !important; }
  .btn-cover:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Status banner */
  .status-banner { padding: 12px 16px; border-radius: 10px; font-size: 13px; font-weight: 600; margin-bottom: 16px; display: none; }
  .status-banner.approved { background: rgba(5,150,105,0.15); color: #34d399; border: 1px solid rgba(5,150,105,0.3); }

  /* Error phase */
  #error-phase { display: none; text-align: center; padding: 60px 20px; }
  #error-phase p { color: var(--red); font-size: 14px; margin-bottom: 16px; }

  /* Empty state */
  .empty-state { text-align: center; padding: 120px 20px; }
  .empty-state h2 { font-size: 22px; font-weight: 700; color: var(--text-muted); margin-bottom: 8px; }
  .empty-state p { color: var(--text-dim); font-size: 14px; }

  /* ── Mobile responsive (< 768px) ── */
  @media (max-width: 767px) {
    .sidebar { transform: translateX(-100%); box-shadow: none; }
    .sidebar.open { transform: translateX(0); box-shadow: 8px 0 24px rgba(0,0,0,0.4); }
    .sidebar-close { display: flex; }
    .sidebar-overlay { display: block; }
    .main-header { display: flex; }
    .main { margin-left: 0; }
    .main-inner { padding: 16px; }
    .preview-comparison { margin-left: 0; width: 100%; padding: 0 16px; }
    .preview-panels { grid-template-columns: 1fr; }
    .preview-panel iframe, .preview-jd { height: 400px; min-height: 150px; }
    .preview-panel .resize-handle { display: flex; }
    .actions button { min-width: 100%; }
    .ats-score { font-size: 36px; }
    .empty-state { padding: 60px 16px; }
    .empty-state h2 { font-size: 18px; }
  }
</style>
</head>
<body>

<!-- ── Sidebar overlay (mobile) ── -->
<div class="sidebar-overlay" id="sidebar-overlay" onclick="closeSidebar()" aria-hidden="true"></div>

<!-- ── Sidebar ── -->
<div class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <div class="sidebar-header-inner">
      <h2>Resume Tailor</h2>
      <button class="new-job-btn" onclick="showNewJob()">+ New Job</button>
    </div>
    <button class="sidebar-close" id="sidebar-close" onclick="closeSidebar()" aria-label="Close menu">×</button>
  </div>
  <div class="thread-list" id="thread-list"></div>
  <div class="sidebar-footer">{{LOGOUT_BTN}}</div>
</div>

<!-- ── Main ── -->
<div class="main">
  <div class="main-header">
    <button class="menu-toggle" id="menu-toggle" onclick="toggleSidebar()" aria-label="Open menu">☰</button>
    <span style="font-size:14px;font-weight:600;color:var(--text)">Resume Tailor</span>
  </div>
  <div class="main-inner">

    <!-- EMPTY STATE (shown when no thread selected) -->
    <div id="empty-state" class="empty-state">
      <h2>No job selected</h2>
      <p>Click "+ New Job" to start tailoring a resume</p>
    </div>

    <!-- INPUT PHASE -->
    <div id="input-phase" style="display:none">
      <div class="input-mode-toggle">
        <button class="active" onclick="setInputMode('url')">Job URL</button>
        <button onclick="setInputMode('jd')">Paste JD</button>
      </div>
      <div id="url-mode">
        <input type="url" class="url-input" id="url-input" placeholder="https://www.linkedin.com/jobs/view/..." />
      </div>
      <div id="jd-mode" style="display:none">
        <textarea class="jd-textarea" id="jd-input" placeholder="Paste the full job description here..."></textarea>
      </div>
      <button class="tailor-btn" id="tailor-btn" onclick="submitJob()">Tailor My Resume</button>
    </div>

    <!-- LOADING -->
    <div id="loading">
      <div class="spinner"></div>
      <p id="loading-text">Processing...</p>
    </div>

    <!-- ERROR PHASE -->
    <div id="error-phase">
      <p id="error-text"></p>
      <button class="tailor-btn" onclick="showNewJob()">Try Again</button>
    </div>

    <!-- RESULTS PHASE -->
    <div id="results-phase">
      <div class="ats-card" id="ats-card"></div>
      <div class="status-banner" id="status-banner"></div>

      <div class="chat-box">
        <div class="chat-header">Chat — request edits before approving</div>
        <div class="messages" id="messages"></div>
        <div class="chat-input">
          <input type="text" id="chat-input" placeholder="Ask about changes or request edits..." onkeydown="if(event.key==='Enter')sendChat()" />
          <button id="send-btn" onclick="sendChat()">Send</button>
        </div>
      </div>

      <div class="actions">
        <button onclick="toggleLatex()">View LaTeX</button>
        <button class="btn-preview" id="preview-btn" onclick="previewPDF()">Preview PDF</button>
        <button class="btn-cover" id="cover-gen-btn" onclick="generateCoverLetter()">Generate Cover Letter</button>
        <button class="btn-cover" id="cover-preview-btn" onclick="previewCoverLetter()" style="display:none">Preview Cover Letter</button>
        <button class="btn-cover btn-cover-save" id="cover-save-btn" onclick="saveCoverLetter()" style="display:none">Save Cover Letter</button>
        <button class="btn-cover" id="cover-download-pdf-btn" onclick="downloadCoverLetterAs('pdf')" style="display:none">Download as PDF</button>
        <button class="btn-cover" id="cover-download-docx-btn" onclick="downloadCoverLetterAs('docx')" style="display:none">Download as DOCX</button>
        <button class="btn-approve" id="approve-btn" onclick="approveResume()">Approve Resume</button>
        <button class="btn-compile" id="compile-btn" onclick="compilePDF()">Compile PDF</button>
      </div>

      <div class="cover-letter-preview" id="cover-letter-preview">
        <button class="preview-close" onclick="closeCoverLetterPreview()">Close</button>
        <div class="cover-letter-toolbar">
          <button class="cover-letter-save" id="cover-letter-save-btn" onclick="saveCoverLetter()">Save</button>
        </div>
        <textarea class="cover-letter-content" id="cover-letter-content" placeholder="Generate a cover letter to edit..."></textarea>
      </div>

      <div class="preview-comparison" id="preview-comparison">
        <button class="preview-close" onclick="closePreview()">Close</button>
        <div class="preview-panels">
          <div class="preview-panel">
            <div class="preview-panel-title" onclick="togglePanel(this)"><span class="collapse-arrow">&#9660;</span> Base Resume</div>
            <iframe id="preview-original"></iframe>
            <div class="resize-handle"></div>
          </div>
          <div class="preview-panel">
            <div class="preview-panel-title" onclick="togglePanel(this)"><span class="collapse-arrow">&#9660;</span> Tailored Resume</div>
            <iframe id="preview-tailored"></iframe>
            <div class="resize-handle"></div>
          </div>
          <div class="preview-panel">
            <div class="preview-panel-title" onclick="togglePanel(this)"><span class="collapse-arrow">&#9660;</span> Job Description</div>
            <div class="preview-jd" id="preview-jd"></div>
            <div class="resize-handle"></div>
          </div>
        </div>
      </div>

      <pre class="latex-preview" id="latex-preview"></pre>
    </div>

  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js"></script>
<script>
const store = {};
let activeId = null;
let inputMode = "url";
let pollTimers = {};

function $(id) { return document.getElementById(id); }

/** Same-origin API calls must send session cookie (especially after login). */
function apiFetch(url, opts) {
  return fetch(url, Object.assign({ credentials: "include" }, opts || {}));
}

/** Render an HTML string to a PDF blob using html2pdf.js */
function htmlToPdfBlob(htmlString, filename) {
  return new Promise((resolve, reject) => {
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = "-9999px";
    container.style.top = "0";
    container.innerHTML = htmlString;
    document.body.appendChild(container);
    const pageEl = container.querySelector(".page") || container;
    // Strip all height/flex constraints — let content flow naturally for html2pdf
    pageEl.style.cssText = "width:8.5in; padding:0.4in 0.5in; margin:0; background:white; height:auto; min-height:0; display:block;";
    // Also override any @media screen styles
    const screenStyles = container.querySelectorAll("style");
    screenStyles.forEach(s => {
      s.textContent = s.textContent.replace(/@media\\s+screen[^{]*\\{[^}]*\\{[^}]*\\}\\s*\\}/g, "");
    });
    html2pdf().set({
      margin: 0,
      filename: (filename || "resume") + ".pdf",
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, letterRendering: true, scrollY: 0, y: 0 },
      jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
    }).from(pageEl).outputPdf("blob").then(blob => {
      document.body.removeChild(container);
      resolve(blob);
    }).catch(err => {
      document.body.removeChild(container);
      reject(err);
    });
  });
}

function toggleSidebar() {
  const sidebar = $("sidebar");
  const overlay = $("sidebar-overlay");
  if (sidebar.classList.contains("open")) {
    closeSidebar();
  } else {
    sidebar.classList.add("open");
    overlay.classList.add("visible");
    overlay.setAttribute("aria-hidden", "false");
  }
}

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-overlay").classList.remove("visible");
  $("sidebar-overlay").setAttribute("aria-hidden", "true");
}

function isMobile() { return window.innerWidth < 768; }

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ── Phases ──

function hideAllPhases() {
  $("empty-state").style.display = "none";
  $("input-phase").style.display = "none";
  $("loading").style.display = "none";
  $("results-phase").style.display = "none";
  $("error-phase").style.display = "none";
}

function showPhase(name) {
  hideAllPhases();
  $(name).style.display = name === "loading" ? "block" : (name === "empty-state" ? "block" : "block");
}

// ── Sidebar ──

function renderSidebar() {
  const list = $("thread-list");
  const ids = Object.keys(store).sort((a, b) => store[b].createdAt - store[a].createdAt);
  list.innerHTML = ids.map(id => {
    const t = store[id];
    const isActive = id === activeId ? " active" : "";
    return '<div class="thread-item' + isActive + '" data-id="' + id + '">'
      + '<div class="thread-dot ' + t.status + '"></div>'
      + '<div class="thread-info">'
      + '<div class="thread-label">' + esc(t.label) + '</div>'
      + '<div class="thread-status">' + t.status + '</div>'
      + '</div></div>';
  }).join("");
}

$("thread-list").addEventListener("click", function(e) {
  const item = e.target.closest(".thread-item");
  if (item && item.dataset.id) selectThread(item.dataset.id);
});

// ── New Job ──

function showNewJob() {
  activeId = null;
  renderSidebar();
  hideAllPhases();
  $("input-phase").style.display = "block";
  $("url-input").value = "";
  $("jd-input").value = "";
  if (isMobile()) closeSidebar();
}

function setInputMode(mode) {
  inputMode = mode;
  $("url-mode").style.display = mode === "url" ? "block" : "none";
  $("jd-mode").style.display = mode === "jd" ? "block" : "none";
  document.querySelectorAll(".input-mode-toggle button").forEach(b => b.classList.remove("active"));
  event.target.classList.add("active");
}

// ── Submit ──

async function submitJob() {
  const body = {};
  if (inputMode === "url") {
    const url = $("url-input").value.trim();
    if (!url) return;
    body.url = url;
  } else {
    const jd = $("jd-input").value.trim();
    if (!jd) return;
    body.jd = jd;
  }

  $("tailor-btn").disabled = true;
  try {
    const res = await apiFetch("/tailor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    store[data.sessionId] = {
      status: data.status,
      label: data.label,
      createdAt: Date.now(),
      approved: false,
      tailoredResume: "",
      coverLetter: "",
      chatMessages: [],
    };

    activeId = data.sessionId;
    renderSidebar();
    showPhase("loading");
    $("loading-text").textContent = "Queued...";
    startPolling(data.sessionId);
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    $("tailor-btn").disabled = false;
  }
}

// ── Polling ──

function startPolling(id) {
  if (pollTimers[id]) return;
  const steps = ["Queued...", "Scraping job page...", "Parsing job description...", "Analyzing ATS match...", "Rewriting resume...", "Checking page count...", "Almost there..."];
  let stepIdx = 0;

  pollTimers[id] = setInterval(async () => {
    try {
      const res = await apiFetch("/session/" + id);
      if (res.status === 401) {
        stopPolling(id);
        window.location.href = "/login";
        return;
      }
      const data = await res.json();

      if (!store[id]) { stopPolling(id); return; }

      store[id].status = data.status;
      if (data.label) store[id].label = data.label;
      renderSidebar();

      if (data.status === "done") {
        stopPolling(id);
        store[id].tailoredResume = data.tailoredResume;
        store[id].baseResume = data.baseResume;
        store[id].parsedJD = data.parsedJD;
        store[id].coverLetter = data.coverLetter || "";
        store[id].atsAnalysis = data.atsAnalysis;
        store[id].serverMessages = data.messages;
        if (activeId === id) showSessionResults(id);
      } else if (data.status === "error") {
        stopPolling(id);
        store[id].error = data.error;
        if (activeId === id) showSessionError(id);
      } else if (activeId === id) {
        stepIdx = Math.min(stepIdx + 1, steps.length - 1);
        $("loading-text").textContent = steps[stepIdx];
      }
    } catch {}
  }, 3000);
}

function stopPolling(id) {
  if (pollTimers[id]) { clearInterval(pollTimers[id]); delete pollTimers[id]; }
}

// ── Thread selection ──

function selectThread(id) {
  activeId = id;
  renderSidebar();
  if (isMobile()) closeSidebar();
  const t = store[id];
  if (!t) return;

  if (t.status === "done") {
    void (async () => {
      try {
        const res = await apiFetch("/session/" + id);
        if (res.ok) {
          const data = await res.json();
          if (data.status === "done" && store[id]) {
            store[id].tailoredResume = data.tailoredResume;
            store[id].baseResume = data.baseResume;
            if (data.parsedJD != null) store[id].parsedJD = data.parsedJD;
            store[id].coverLetter = data.coverLetter || "";
            if (data.atsAnalysis) store[id].atsAnalysis = data.atsAnalysis;
            if (data.messages) store[id].serverMessages = data.messages;
          }
        }
      } catch {}
      if (activeId === id) showSessionResults(id);
    })();
  } else if (t.status === "error") {
    showSessionError(id);
  } else {
    showPhase("loading");
    $("loading-text").textContent = t.status === "queued" ? "Queued..." : "Processing...";
    startPolling(id);
  }
}

function showSessionResults(id) {
  const t = store[id];
  showPhase("results-phase");

  renderATS(t.atsAnalysis || {});
  $("messages").innerHTML = "";
  if (t.serverMessages) {
    for (const m of t.serverMessages) appendMsg(m.role, m.content);
  }
  for (const m of (t.chatMessages || [])) appendMsg(m.role, m.content);

  $("latex-preview").textContent = t.tailoredResume || "";
  $("latex-preview").style.display = "none";
  closePreview();
  closeCoverLetterPreview();

  const hasCover = t.coverLetter && t.coverLetter.length > 0;
  $("cover-preview-btn").style.display = hasCover ? "" : "none";
  $("cover-save-btn").style.display = hasCover ? "" : "none";
  $("cover-download-pdf-btn").style.display = hasCover ? "" : "none";
  $("cover-download-docx-btn").style.display = hasCover ? "" : "none";

  if (t.approved) {
    $("approve-btn").style.display = "none";
    $("compile-btn").style.display = "";
    const banner = $("status-banner");
    banner.className = "status-banner approved";
    banner.textContent = "Resume approved. You can now compile to PDF.";
    banner.style.display = "block";
  } else {
    $("approve-btn").style.display = "";
    $("compile-btn").style.display = "none";
    $("status-banner").style.display = "none";
  }
}

function showSessionError(id) {
  const t = store[id];
  showPhase("error-phase");
  $("error-text").textContent = t.error || "An unknown error occurred.";
}

// ── ATS ──

function renderATS(ats) {
  const card = $("ats-card");
  const title = ats.jobTitle || "";
  const company = ats.company || "";
  const matchedTags = (ats.matched || []).map(k => '<span class="tag tag-matched">' + esc(k) + '</span>').join("");
  const missingTags = (ats.missing || []).map(k => '<span class="tag tag-missing">' + esc(k) + '</span>').join("");
  card.innerHTML =
    (title ? '<div class="ats-job-title">' + esc(title) + (company ? ' at ' + esc(company) : '') + '</div>' : '') +
    '<div class="ats-header"><span class="ats-score">' + (ats.score ?? 0) + '%</span><span class="ats-score-label">ATS Match</span></div>' +
    '<div class="keywords-row">' +
    '<div class="keywords-group"><h4>Matched</h4><div>' + (matchedTags || '<span class="tag tag-matched">none</span>') + '</div></div>' +
    '<div class="keywords-group"><h4>Missing</h4><div>' + (missingTags || '<span class="tag tag-missing">none</span>') + '</div></div>' +
    '</div>';
}

// ── Chat ──

function appendMsg(role, content) {
  const container = $("messages");
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = content;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function sendChat() {
  if (!activeId || !store[activeId] || store[activeId].status !== "done") return;
  const input = $("chat-input");
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  appendMsg("user", msg);
  store[activeId].chatMessages.push({ role: "user", content: msg });

  $("send-btn").disabled = true;
  try {
    const res = await apiFetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: activeId, message: msg }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    appendMsg("assistant", data.content);
    store[activeId].chatMessages.push({ role: "assistant", content: data.content });
    if (data.resumeUpdateRejected) {
      appendMsg("assistant", "[Resume not updated] " + data.resumeUpdateRejected);
      store[activeId].chatMessages.push({
        role: "assistant",
        content: "[Resume not updated] " + data.resumeUpdateRejected,
      });
    }
    if (data.resumeUpdated) {
      store[activeId].tailoredResume = data.tailoredResume;
      $("latex-preview").textContent = data.tailoredResume;
      if (store[activeId].approved) {
        store[activeId].approved = false;
        $("approve-btn").style.display = "";
        $("compile-btn").style.display = "none";
        $("status-banner").style.display = "none";
      }
    }
  } catch (err) {
    appendMsg("assistant", "Error: " + err.message);
  } finally {
    $("send-btn").disabled = false;
  }
}

// ── Actions ──

function approveResume() {
  if (!activeId || !store[activeId]) return;
  store[activeId].approved = true;
  $("approve-btn").style.display = "none";
  $("compile-btn").style.display = "";
  const banner = $("status-banner");
  banner.className = "status-banner approved";
  banner.textContent = "Resume approved. You can now compile to PDF.";
  banner.style.display = "block";
}

async function compilePDF() {
  if (!activeId || !store[activeId]) return;
  const btn = $("compile-btn");
  btn.textContent = "Compiling...";
  btn.disabled = true;
  try {
    const res = await apiFetch("/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: activeId, tailoredResume: store[activeId].tailoredResume }),
    });
    if (!res.ok) {
      let msg = "Compilation failed";
      try {
        const err = await res.json();
        msg = (err.error || msg) + (err.details ? ("\\n\\n" + err.details) : "");
      } catch { msg = await res.text() || msg; }
      throw new Error(msg);
    }
    const data = await res.json();
    const blob = await htmlToPdfBlob(data.html, data.filename || "tailored-resume");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (data.filename || "tailored-resume") + ".pdf";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Compile error: " + err.message);
  } finally {
    btn.textContent = "Compile PDF";
    btn.disabled = false;
  }
}

function toggleLatex() {
  const el = $("latex-preview");
  el.style.display = el.style.display === "none" ? "block" : "none";
}

async function previewPDF() {
  if (!activeId || !store[activeId] || !store[activeId].tailoredResume) return;
  const btn = $("preview-btn");
  btn.disabled = true;
  btn.textContent = "Compiling...";
  try {
    const s = store[activeId];

    const fetchHtml = (url, body) => apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => {
      if (!r.ok) return r.json().then(e => { throw new Error(e.error || "Failed"); });
      return r.json();
    });

    const [tailoredData, baseData] = await Promise.all([
      fetchHtml("/compile", { sessionId: activeId, tailoredResume: s.tailoredResume }),
      fetchHtml("/compile-base", {}),
    ]);

    const [tailoredBlob, baseBlob] = await Promise.all([
      htmlToPdfBlob(tailoredData.html, tailoredData.filename || "tailored-resume"),
      htmlToPdfBlob(baseData.html, "base-resume"),
    ]);

    revokePreviewUrls();

    const tailoredUrl = URL.createObjectURL(tailoredBlob);
    $("preview-tailored").src = tailoredUrl;

    const baseUrl = URL.createObjectURL(baseBlob);
    $("preview-original").src = baseUrl;

    const jdEl = $("preview-jd");
    if (s.parsedJD) {
      try {
        const parsed = JSON.parse(s.parsedJD.replace(/^\`\`\`json?\\s*/i, "").replace(/\\s*\`\`\`$/i, ""));
        let text = "";
        if (parsed.jobTitle) text += "Job Title: " + parsed.jobTitle + "\\n";
        if (parsed.company) text += "Company: " + parsed.company + "\\n";
        if (parsed.requirements) text += "\\nRequirements:\\n" + parsed.requirements.map(r => "  - " + r).join("\\n") + "\\n";
        if (parsed.niceToHaves) text += "\\nNice to Have:\\n" + parsed.niceToHaves.map(r => "  - " + r).join("\\n") + "\\n";
        if (parsed.primaryKeywords) text += "\\nPrimary Keywords: " + parsed.primaryKeywords.join(", ") + "\\n";
        if (parsed.secondaryKeywords) text += "Secondary Keywords: " + parsed.secondaryKeywords.join(", ") + "\\n";
        if (parsed.implicitSkills) text += "Implicit Skills: " + parsed.implicitSkills.join(", ") + "\\n";
        jdEl.textContent = text || s.parsedJD;
      } catch { jdEl.textContent = s.parsedJD; }
    } else {
      jdEl.textContent = "(Job description not available)";
    }

    $("preview-comparison").style.display = "block";
  } catch (err) {
    alert("Preview error: " + err.message);
  } finally {
    btn.textContent = "Preview PDF";
    btn.disabled = false;
  }
}

function revokePreviewUrls() {
  ["preview-original", "preview-tailored"].forEach(id => {
    const f = $(id);
    if (f && f.src && f.src.startsWith("blob:")) { URL.revokeObjectURL(f.src); f.src = ""; }
  });
}

function closePreview() {
  $("preview-comparison").style.display = "none";
  revokePreviewUrls();
}

async function generateCoverLetter() {
  if (!activeId || !store[activeId] || store[activeId].status !== "done") return;
  const btn = $("cover-gen-btn");
  btn.disabled = true;
  btn.textContent = "Generating...";
  try {
    const res = await apiFetch("/cover-letter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: activeId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to generate cover letter");
    store[activeId].coverLetter = data.coverLetter || "";
    $("cover-preview-btn").style.display = "";
    $("cover-save-btn").style.display = "";
    $("cover-download-pdf-btn").style.display = "";
    $("cover-download-docx-btn").style.display = "";
    previewCoverLetter();
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    btn.textContent = "Generate Cover Letter";
    btn.disabled = false;
  }
}

function previewCoverLetter() {
  if (!activeId || !store[activeId]) return;
  const content = store[activeId].coverLetter || "";
  $("cover-letter-content").value = content;
  $("cover-letter-preview").style.display = "block";
}

function closeCoverLetterPreview() {
  $("cover-letter-preview").style.display = "none";
}

async function saveCoverLetter() {
  if (!activeId || !store[activeId]) return;
  const panel = $("cover-letter-preview");
  const textarea = $("cover-letter-content");
  const content = (panel.style.display === "block" ? textarea.value : store[activeId].coverLetter || "").trim();
  const toolbarBtn = $("cover-letter-save-btn");
  const mainBtn = $("cover-save-btn");
  [toolbarBtn, mainBtn].forEach(b => { if (b) { b.disabled = true; b.textContent = "Saving..."; } });
  try {
    const res = await apiFetch("/cover-letter/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: activeId, coverLetter: content }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");
    store[activeId].coverLetter = content;
    if (panel.style.display === "block") textarea.value = content;
    [toolbarBtn, mainBtn].forEach(b => {
      if (b) {
        b.textContent = "Saved";
        b.classList.add("saved");
        b.disabled = false;
      }
    });
    setTimeout(() => {
      [toolbarBtn, mainBtn].forEach(b => {
        if (b) { b.textContent = b === mainBtn ? "Save Cover Letter" : "Save"; b.classList.remove("saved"); }
      });
    }, 2000);
  } catch (err) {
    alert("Error: " + err.message);
    [toolbarBtn, mainBtn].forEach(b => { if (b) { b.disabled = false; b.textContent = b === mainBtn ? "Save Cover Letter" : "Save"; } });
  }
}

async function downloadCoverLetterAs(format) {
  if (!activeId || !store[activeId] || !store[activeId].coverLetter) return;
  try {
    const res = await apiFetch("/cover-letter/download/" + format, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: activeId }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Download failed");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const fn = res.headers.get("X-Suggested-Filename") || (format === "pdf" ? "cover-letter.pdf" : "cover-letter.docx");
    a.download = fn;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function init() {
  try {
    const res = await apiFetch("/sessions");
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const jobs = await res.json();
    for (const j of jobs) {
      store[j.id] = {
        status: j.status,
        label: j.label,
        createdAt: j.createdAt || j.created_at,
        approved: false,
        tailoredResume: "",
        baseResume: "",
        parsedJD: "",
        coverLetter: "",
        chatMessages: [],
      };
      if (j.status === "done") {
        const sr = await apiFetch("/session/" + j.id);
        const data = await sr.json();
        if (data.status === "done") {
          store[j.id].tailoredResume = data.tailoredResume;
          store[j.id].baseResume = data.baseResume;
          store[j.id].parsedJD = data.parsedJD;
          store[j.id].coverLetter = data.coverLetter || "";
          store[j.id].atsAnalysis = data.atsAnalysis;
          store[j.id].serverMessages = data.messages;
        }
      } else if (j.status === "queued" || j.status === "processing") {
        startPolling(j.id);
      }
    }
    renderSidebar();
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}

// -- Panel collapse/expand --
function togglePanel(titleEl) {
  const panel = titleEl.closest('.preview-panel');
  panel.classList.toggle('collapsed');
}

// -- Drag-to-resize panel height (mobile) --
(function() {
  let activePanel = null;
  let startY = 0;
  let startH = 0;
  let contentEl = null;

  function getContentEl(panel) {
    return panel.querySelector('iframe') || panel.querySelector('.preview-jd');
  }

  document.querySelectorAll('.resize-handle').forEach(function(handle) {
    handle.addEventListener('mousedown', onStart, { passive: false });
    handle.addEventListener('touchstart', onStart, { passive: false });
  });

  function onStart(e) {
    const handle = e.currentTarget;
    activePanel = handle.closest('.preview-panel');
    contentEl = getContentEl(activePanel);
    if (!contentEl) return;
    activePanel.classList.add('resizing');
    contentEl.style.flex = 'none';
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startH = contentEl.getBoundingClientRect().height;
    document.addEventListener('mousemove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    if (!activePanel) return;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const delta = clientY - startY;
    const newH = Math.max(150, startH + delta);
    contentEl.style.height = newH + 'px';
    e.preventDefault();
  }

  function onEnd() {
    if (activePanel) activePanel.classList.remove('resizing');
    activePanel = null;
    contentEl = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
  }
})();

init();
</script>
</body>
</html>`;

hydrateFromDb();
ensureScrapedJobsTable();

app.listen(PORT, () => {
  console.log(`\n🚀 Resume Tailor running on http://localhost:${PORT}`);
  console.log(`📄 Base resume file: ${RESUME_PATH}`);
  if (isTelegramConfigured()) {
    console.log(`🤖 Telegram bot connected`);
  } else {
    console.log(`⚠️  Telegram not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env)`);
  }
  console.log(`\nOpen http://localhost:${PORT} in your browser to start.\n`);
});
