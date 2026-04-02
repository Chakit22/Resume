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
  const row = getDb().prepare('SELECT 1 FROM scraped_jobs WHERE url = ?').get(url);
  return !!row;
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
  getDb().prepare(`
    INSERT OR IGNORE INTO scraped_jobs (id, title, company, location, salary, url, posted_at, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job.id, job.title, job.company, job.location, job.salary, job.url, job.postedAt, job.source, Date.now());
}

export function markNotified(id: string) {
  getDb().prepare('UPDATE scraped_jobs SET notified = 1 WHERE id = ?').run(id);
}

export function markTailored(id: string, sessionId: string) {
  getDb().prepare('UPDATE scraped_jobs SET tailored = 1, session_id = ? WHERE id = ?').run(sessionId, id);
}

export function getScrapedJobs(limit = 50): ScrapedJob[] {
  const rows = getDb().prepare(
    'SELECT * FROM scraped_jobs ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as any[];
  return rows.map(r => ({
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

export function getScrapedJobByUrl(url: string): ScrapedJob | null {
  const r = getDb().prepare('SELECT * FROM scraped_jobs WHERE url = ?').get(url) as any;
  if (!r) return null;
  return {
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
  };
}

// ── Search Queries ──

const SEARCH_QUERIES = [
  'Software Engineer',
  'AI Engineer',
  'Full Stack Developer',
  'Software Developer',
  'Backend Engineer',
];

// Filter out senior roles
const SENIOR_KEYWORDS = [
  'senior', 'sr.', 'sr ', 'lead', 'principal', 'staff', 'director', 'manager', 'head of', 'vp ',
];

function isSeniorRole(title: string): boolean {
  const lower = title.toLowerCase();
  return SENIOR_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Process Apify Webhook Results ──

export async function processApifyResults(
  results: any[],
  source: string,
  appBaseUrl: string,
): Promise<number> {
  let newCount = 0;

  for (const item of results) {
    // Normalize fields from different Apify actors
    const title = item.title || item.jobTitle || '';
    const company = item.company || item.companyName || item.advertiser || '';
    const location = item.location || item.jobLocation || '';
    const salary = item.salary || item.salaryRange || '';
    const url = item.url || item.jobUrl || item.link || '';
    const postedAt = item.postedAt || item.listedDate || item.date || '';

    if (!title || !url) continue;
    if (isSeniorRole(title)) continue;
    if (jobExists(url)) continue;

    const id = crypto.randomUUID();
    insertScrapedJob({ id, title, company, location, salary, url, postedAt, source });

    // Send Telegram alert
    try {
      await sendJobAlert({ title, company, location, salary, url, postedAt, appBaseUrl });
      markNotified(id);
    } catch (err) {
      console.error(`[jobScraper] Telegram alert failed for ${title}:`, err);
    }

    newCount++;
  }

  console.log(`✅ [jobScraper] Processed ${results.length} results, ${newCount} new jobs from ${source}.`);
  return newCount;
}

// ── Trigger Apify Seek Scraper ──

export async function triggerSeekScrape(): Promise<string | null> {
  if (!APIFY_TOKEN) {
    console.warn('[jobScraper] APIFY_API_TOKEN not set, skipping.');
    return null;
  }

  const actorId = 'websift~seek-job-scraper-pay-per-row';

  for (const query of SEARCH_QUERIES) {
    const seekUrl = `https://www.seek.com.au/${query.toLowerCase().replace(/\s+/g, '-')}-jobs/in-All-Australia?sortmode=ListedDate`;

    try {
      const res = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchUrl: seekUrl,
            maxItems: 20,
          }),
        },
      );
      const data: any = await res.json();
      if (data?.data?.id) {
        console.log(`[jobScraper] Triggered Seek scrape for "${query}": run ${data.data.id}`);
      } else {
        console.error(`[jobScraper] Seek scrape failed for "${query}":`, JSON.stringify(data).slice(0, 300));
      }
    } catch (err) {
      console.error(`[jobScraper] Failed to trigger Seek scrape for "${query}":`, err);
    }
  }

  return 'triggered';
}

// ── Trigger Apify LinkedIn Scraper ──

export async function triggerLinkedInScrape(): Promise<string | null> {
  if (!APIFY_TOKEN) {
    console.warn('[jobScraper] APIFY_API_TOKEN not set, skipping.');
    return null;
  }

  const actorId = 'curious_coder~linkedin-jobs-scraper';

  for (const query of SEARCH_QUERIES) {
    try {
      const res = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: query,
            location: 'Australia',
            rows: 20,
            publishedAt: 'r86400',
          }),
        },
      );
      const data: any = await res.json();
      if (data?.data?.id) {
        console.log(`[jobScraper] Triggered LinkedIn scrape for "${query}": run ${data.data.id}`);
      } else {
        console.error(`[jobScraper] LinkedIn scrape failed for "${query}":`, JSON.stringify(data).slice(0, 300));
      }
    } catch (err) {
      console.error(`[jobScraper] Failed to trigger LinkedIn scrape for "${query}":`, err);
    }
  }

  return 'triggered';
}
