import { getDb } from './db.js';
import { sendJobAlert } from './telegram.js';
import dotenv from 'dotenv';
dotenv.config();

const APIFY_TOKEN = process.env.APIFY_API_TOKEN?.trim();

// ── DB Setup ──

export function ensureScrapedJobsTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS scraped_jobs (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      company     TEXT NOT NULL,
      location    TEXT NOT NULL DEFAULT '',
      salary      TEXT NOT NULL DEFAULT '',
      url         TEXT NOT NULL UNIQUE,
      posted_at   TEXT NOT NULL DEFAULT '',
      source      TEXT NOT NULL DEFAULT 'seek',
      notified    INTEGER NOT NULL DEFAULT 0,
      tailored    INTEGER NOT NULL DEFAULT 0,
      session_id  TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scraped_url ON scraped_jobs(url);
  `);

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS apify_runs (
      run_id      TEXT PRIMARY KEY,
      actor       TEXT NOT NULL,
      processed   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
  `);
}

export interface ScrapedJob {
  id: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  url: string;
  postedAt: string;
  source: string;
  notified: boolean;
  tailored: boolean;
  sessionId: string | null;
  createdAt: number;
}

// ── CRUD ──

function jobExists(url: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM scraped_jobs WHERE url = ?').get(url);
}

function insertScrapedJob(job: {
  id: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  url: string;
  postedAt: string;
  source: string;
}) {
  getDb()
    .prepare(
      `
    INSERT OR IGNORE INTO scraped_jobs (id, title, company, location, salary, url, posted_at, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      job.id,
      job.title,
      job.company,
      job.location,
      job.salary,
      job.url,
      job.postedAt,
      job.source,
      Date.now(),
    );
}

export function markNotified(id: string) {
  getDb().prepare('UPDATE scraped_jobs SET notified = 1 WHERE id = ?').run(id);
}

export function markTailored(id: string, sessionId: string) {
  getDb()
    .prepare(
      'UPDATE scraped_jobs SET tailored = 1, session_id = ? WHERE id = ?',
    )
    .run(sessionId, id);
}

export function getScrapedJobs(limit = 50): ScrapedJob[] {
  const rows = getDb()
    .prepare('SELECT * FROM scraped_jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    salary: r.salary,
    url: r.url,
    postedAt: r.posted_at,
    source: r.source,
    notified: !!r.notified,
    tailored: !!r.tailored,
    sessionId: r.session_id,
    createdAt: r.created_at,
  }));
}

// ── Run tracking ──

function trackRun(runId: string, actor: string) {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO apify_runs (run_id, actor, processed, created_at) VALUES (?, ?, 0, ?)',
    )
    .run(runId, actor, Date.now());
}

function getUnprocessedRuns(): Array<{ run_id: string; actor: string }> {
  return getDb()
    .prepare('SELECT run_id, actor FROM apify_runs WHERE processed = 0')
    .all() as any[];
}

function markRunProcessed(runId: string) {
  getDb()
    .prepare('UPDATE apify_runs SET processed = 1 WHERE run_id = ?')
    .run(runId);
}

// ── Filters ──

const SEARCH_QUERIES = [
  'Software Engineer',
  'AI Engineer',
  'Full Stack Developer',
  'Software Developer',
  'Backend Engineer',
];

const SENIOR_KEYWORDS = [
  'senior',
  'sr.',
  'sr ',
  'lead',
  'principal',
  'staff',
  'director',
  'manager',
  'head of',
  'vp ',
];

function isSeniorRole(title: string): boolean {
  const lower = title.toLowerCase();
  return SENIOR_KEYWORDS.some((kw) => lower.includes(kw));
}

// Only keep jobs whose title matches software/tech roles
const RELEVANT_KEYWORDS = [
  'software',
  'developer',
  'engineer',
  'frontend',
  'front-end',
  'front end',
  'backend',
  'back-end',
  'back end',
  'full stack',
  'full-stack',
  'fullstack',
  'devops',
  'sre',
  'platform',
  'cloud',
  'data engineer',
  'ml engineer',
  'machine learning',
  'ai engineer',
  'python',
  'node',
  'react',
  'typescript',
  'java developer',
  'golang',
  'rust developer',
  'ios developer',
  'android developer',
  'mobile developer',
  'web developer',
  'api developer',
  'solutions engineer',
];

function isRelevantRole(title: string): boolean {
  const lower = title.toLowerCase();
  return RELEVANT_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Process results ──

export async function processApifyResults(
  results: any[],
  source: string,
  appBaseUrl: string,
): Promise<number> {
  let newCount = 0;

  for (const item of results) {
    const title = item.title || item.jobTitle || '';
    const company =
      item.company || item.companyName || item.advertiserDescription || '';
    const url = item.url || item.jobLink || item.jobUrl || item.link || '';
    const salary = item.salary || item.salaryRange || '';
    const postedAt =
      item.postedAt || item.listingDate || item.listedDate || item.date || '';
    let location = '';
    if (typeof item.location === 'string') {
      location = item.location;
    } else if (Array.isArray(item.jobLocation) && item.jobLocation.length > 0) {
      location = item.jobLocation[0].label || '';
    } else if (typeof item.jobLocation === 'string') {
      location = item.jobLocation;
    }

    if (!title || !url) continue;
    if (!isRelevantRole(title)) continue;
    if (isSeniorRole(title)) continue;
    if (jobExists(url)) continue;

    const id = crypto.randomUUID();
    insertScrapedJob({
      id,
      title,
      company,
      location,
      salary,
      url,
      postedAt,
      source,
    });

    try {
      await sendJobAlert({
        title,
        company,
        location,
        salary,
        url,
        postedAt,
        appBaseUrl,
      });
      markNotified(id);
    } catch (err) {
      console.error(`[jobScraper] Telegram alert failed for ${title}:`, err);
    }

    newCount++;
  }

  console.log(
    `✅ [jobScraper] Processed ${results.length} results, ${newCount} new jobs from ${source}.`,
  );
  return newCount;
}

// ── Trigger actors ──

async function triggerActor(
  actorId: string,
  input: Record<string, any>,
): Promise<string | null> {
  if (!APIFY_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    const data: any = await res.json();
    if (data?.data?.id) {
      console.log(`[jobScraper] Started run ${data.data.id} for ${actorId}`);
      trackRun(data.data.id, actorId);
      return data.data.id;
    }
    console.error(
      `[jobScraper] Failed to start ${actorId}:`,
      JSON.stringify(data).slice(0, 200),
    );
  } catch (err) {
    console.error(`[jobScraper] Error starting ${actorId}:`, err);
  }
  return null;
}

export async function triggerSeekScrape(): Promise<void> {
  if (!APIFY_TOKEN) return;
  for (const query of SEARCH_QUERIES) {
    await triggerActor('websift~seek-job-scraper', {
      searchTerm: query,
      country: 'australia',
      dateRange: 1,
      maxResults: 100,
      sortBy: 'ListedDate',
      'developers-programmers': true,
      'engineering-software': true,
      'web-development-production': true,
    });
  }
}

export async function triggerLinkedInScrape(): Promise<void> {
  if (!APIFY_TOKEN) return;
  const urls = SEARCH_QUERIES.map(query =>
    `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(query)}&location=Australia&geoId=101452733&f_JT=F%2CC&f_E=2%2C4&f_TPR=r86400&position=1&pageNum=0`,
  );
  await triggerActor('curious_coder~linkedin-jobs-scraper', {
    urls,
    count: 10,
    scrapeCompany: false,
  });
}

// ── Poll for completed runs ──

export async function pollForResults(appBaseUrl: string): Promise<number> {
  if (!APIFY_TOKEN) return 0;

  const pending = getUnprocessedRuns();
  if (pending.length === 0) return 0;

  console.log(`[jobScraper] Polling ${pending.length} pending runs...`);
  let totalNew = 0;

  for (const run of pending) {
    try {
      const res = await fetch(
        `https://api.apify.com/v2/actor-runs/${run.run_id}?token=${APIFY_TOKEN}`,
      );
      const data: any = await res.json();
      const status = data?.data?.status;

      if (status === 'SUCCEEDED') {
        const datasetId = data.data.defaultDatasetId;
        if (datasetId) {
          const itemsRes = await fetch(
            `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`,
          );
          const items = (await itemsRes.json()) as any[];
          const source = run.actor.includes('seek') ? 'seek' : 'linkedin';
          totalNew += await processApifyResults(items, source, appBaseUrl);
        }
        markRunProcessed(run.run_id);
      } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
        console.error(`[jobScraper] Run ${run.run_id} ${status}`);
        markRunProcessed(run.run_id);
      }
    } catch (err) {
      console.error(`[jobScraper] Error polling run ${run.run_id}:`, err);
    }
  }

  return totalNew;
}

// ── Scheduler — runs inside server process ──

export function startJobScheduler(appBaseUrl: string) {
  if (!APIFY_TOKEN) {
    console.log(
      '[jobScraper] ⚠️  APIFY_API_TOKEN not set — scheduler disabled.',
    );
    return;
  }

  // Poll for completed runs every 2 minutes
  setInterval(() => pollForResults(appBaseUrl), 2 * 60 * 1000);

  // Check every 30 min if it's time to trigger scrapes (11pm AEST, once per day)
  setInterval(
    async () => {
      const aestHour = (new Date().getUTCHours() + 10) % 24;
      const minute = new Date().getMinutes();
      if (aestHour === 23 && minute < 30) {
        console.log(
          `[jobScraper] 🔄 Daily scrape at ${aestHour}:${minute} AEST`,
        );
        await triggerSeekScrape();
        await triggerLinkedInScrape();
      }
    },
    30 * 60 * 1000,
  );

  console.log('[jobScraper] 🚀 Scheduler started. Daily scrape at 11pm AEST. Use /api/trigger-scrape for manual runs.');
}
