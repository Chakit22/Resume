import dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

export function isTelegramConfigured(): boolean {
  return !!(BOT_TOKEN && CHAT_ID);
}

async function callTelegram(method: string, body: Record<string, any>) {
  if (!BOT_TOKEN) {
    console.warn('[telegram] BOT_TOKEN not set, skipping.');
    return null;
  }
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!data.ok) {
    console.error(`[telegram] ${method} failed:`, data.description);
  }
  return data;
}

/**
 * Send a new job alert with Tailor + Apply buttons.
 */
export async function sendJobAlert(job: {
  title: string;
  company: string;
  location: string;
  salary?: string;
  url: string;
  postedAt?: string;
  appBaseUrl: string;
}) {
  if (!CHAT_ID) {
    console.warn('[telegram] CHAT_ID not set, skipping.');
    return;
  }

  const salary = job.salary ? `\n💰 ${job.salary}` : '';
  const posted = job.postedAt ? `\n🕐 ${job.postedAt}` : '';

  const text =
    `🆕 *New Job Match*\n\n` +
    `*${escapeMarkdown(job.title)}*\n` +
    `🏢 ${escapeMarkdown(job.company)}\n` +
    `📍 ${escapeMarkdown(job.location)}` +
    salary +
    posted;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Tailor Resume', url: `${job.appBaseUrl}?autoTailor=${encodeURIComponent(job.url)}` },
        { text: '🔍 View Job', url: job.url },
      ],
    ],
  };

  return callTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

/**
 * Send a message that the resume is ready with links.
 */
export async function sendTailorComplete(job: {
  title: string;
  company: string;
  sessionUrl: string;
  applyUrl: string;
}) {
  if (!CHAT_ID) return;

  const text =
    `✅ *Resume Tailored*\n\n` +
    `*${escapeMarkdown(job.title)}* at *${escapeMarkdown(job.company)}*\n\n` +
    `Your tailored resume is ready.`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📄 View & Download', url: job.sessionUrl },
        { text: '📨 Apply Now', url: job.applyUrl },
      ],
    ],
  };

  return callTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });
}

/**
 * Send a simple text message.
 */
export async function sendMessage(text: string) {
  if (!CHAT_ID) return;
  return callTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
  });
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

/**
 * Get bot updates (used to find your chat_id).
 */
export async function getUpdates() {
  return callTelegram('getUpdates', {});
}
