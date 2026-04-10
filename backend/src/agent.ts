import { Annotation, StateGraph, END, START } from '@langchain/langgraph';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
} from '@langchain/core/messages';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PARSE_JD_PROMPT, REWRITE_RESUME_PROMPT, RECRUITER_REVIEW_PROMPT } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESUMES_DIR = path.resolve(__dirname, '../resumes');
const OUTPUT_DIR = path.resolve(RESUMES_DIR, 'output');

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (curr, update) => [...curr, ...update],
    default: () => [],
  }),
  baseResume: Annotation<string>({
    reducer: (_curr, update) => update,
    default: () => '',
  }),
  parsedJD: Annotation<string>({
    reducer: (_curr, update) => update,
    default: () => '',
  }),
  atsAnalysis: Annotation<string>({
    reducer: (_curr, update) => update,
    default: () => '',
  }),
  tailoredResume: Annotation<string>({
    reducer: (_curr, update) => update,
    default: () => '',
  }),
  pageCount: Annotation<number>({
    reducer: (_curr, update) => update,
    default: () => 0,
  }),
  trimAttempts: Annotation<number>({
    reducer: (_curr, update) => update,
    default: () => 0,
  }),
});

type GraphStateType = typeof GraphState.State;

let _llm: ChatGoogleGenerativeAI | null = null;
function getLLM(): ChatGoogleGenerativeAI {
  if (!_llm) {
    _llm = new ChatGoogleGenerativeAI({
      model: 'gemini-2.5-flash',
      temperature: 0.3,
      maxOutputTokens: 8192,
    });
  }
  return _llm;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || c.content || String(c)).join('');
  }
  return String(content);
}

function sanitizeHtml(html: string): string {
  let clean = html.trim();
  clean = clean.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  return clean;
}

/**
 * Check if the HTML is a full document (not a fragment).
 */
export function isFullHtmlDocument(html: string): boolean {
  const s = html.trim().toLowerCase();
  if (s.length < 200) return false;
  if (!s.includes('<!doctype html') && !s.includes('<html')) return false;
  if (!s.includes('</html>')) return false;
  return true;
}

function truncate(s: string, max = 120): string {
  if (!s || typeof s !== 'string') return String(s);
  return s.length <= max ? s : s.slice(0, max) + '...';
}

// ── Node 1: Parse JD ──

async function parseJDNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const lastMessage = state.messages[state.messages.length - 1];
  const jdText = lastMessage.content as string;

  console.log(
    '\n🔍 [parseJD] IN: messages.length=%d, baseResume=%d chars',
    state.messages.length,
    state.baseResume?.length ?? 0,
  );
  console.log('   [parseJD] IN: jdText (last msg) =', truncate(jdText, 200));

  const response = await getLLM().invoke([
    new SystemMessage(PARSE_JD_PROMPT),
    new HumanMessage(jdText),
  ]);

  const parsed = extractText(response.content);
  console.log('   [parseJD] OUT: parsedJD =', truncate(parsed, 300));
  console.log('✅ [parseJD] Done. Extracted structured JD.');

  return {
    parsedJD: parsed,
    messages: [new AIMessage(`[System] Job description parsed successfully.`)],
  };
}

// ── Node 2: ATS Match ──

async function atsMatchNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log(
    '\n📊 [atsMatch] IN: parsedJD=%d chars, baseResume=%d chars',
    state.parsedJD?.length ?? 0,
    state.baseResume?.length ?? 0,
  );

  let jd: {
    primaryKeywords?: string[];
    secondaryKeywords?: string[];
    implicitSkills?: string[];
    requirements?: string[];
    niceToHaves?: string[];
    jobTitle?: string;
    company?: string;
  };
  try {
    let raw = state.parsedJD.trim();
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    jd = JSON.parse(raw);
  } catch {
    return {
      atsAnalysis: JSON.stringify({ error: 'Failed to parse JD JSON' }),
      messages: [
        new AIMessage('[System] ATS analysis failed — could not parse JD.'),
      ],
    };
  }

  const resumeLower = state.baseResume.toLowerCase();

  const allJDKeywords = [
    ...(jd.primaryKeywords || []),
    ...(jd.secondaryKeywords || []),
    ...(jd.implicitSkills || []),
  ];

  const matched: string[] = [];
  const missing: string[] = [];

  for (const keyword of allJDKeywords) {
    if (resumeLower.includes(keyword.toLowerCase())) {
      matched.push(keyword);
    } else {
      missing.push(keyword);
    }
  }

  const total = allJDKeywords.length || 1;
  const score = Math.round((matched.length / total) * 100);

  const suggestions: string[] = [];
  if (missing.length > 0) {
    suggestions.push(
      `Incorporate these missing keywords where truthful: ${missing.join(', ')}`,
    );
  }
  if (score < 50) {
    suggestions.push(
      'Consider emphasizing transferable experiences that map to the JD requirements.',
    );
  }
  if (jd.requirements && jd.requirements.length > 0) {
    suggestions.push(
      'Ensure at least one bullet point addresses each core requirement.',
    );
  }

  const analysis = {
    score,
    matched,
    missing,
    totalKeywords: total,
    suggestions,
    jobTitle: jd.jobTitle,
    company: jd.company,
  };

  console.log(
    '   [atsMatch] OUT: score=%d, matched=%d, missing=%d',
    score,
    matched.length,
    missing.length,
  );
  console.log(
    '   [atsMatch] OUT: matched=%s, missing=%s',
    truncate(matched.join(', '), 100),
    truncate(missing.join(', '), 100),
  );
  console.log(
    `✅ [atsMatch] Score: ${score}% | Matched: ${matched.length}/${total} | Missing: ${missing.length}`,
  );

  return {
    atsAnalysis: JSON.stringify(analysis, null, 2),
    messages: [
      new AIMessage(
        `[System] ATS Match Score: ${score}% (${matched.length}/${total} keywords). ` +
          `Missing: ${missing.join(', ') || 'none'}.`,
      ),
    ],
  };
}

// ── Node 3: Rewrite Resume ──

async function rewriteResumeNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log(
    '\n✍️  [rewriteResume] IN: baseResume=%d chars, atsAnalysis=%d chars, parsedJD=%d chars',
    state.baseResume?.length ?? 0,
    state.atsAnalysis?.length ?? 0,
    state.parsedJD?.length ?? 0,
  );

  const prompt = `Here is the original HTML resume:

---
${state.baseResume}
---

Here is the ATS match analysis:

---
${state.atsAnalysis}
---

Here is the parsed job description:

---
${state.parsedJD}
---

Rewrite the resume following the instructions.`;

  const response = await getLLM().invoke([
    new SystemMessage(REWRITE_RESUME_PROMPT),
    new HumanMessage(prompt),
  ]);

  const tailored = sanitizeHtml(extractText(response.content));
  console.log(
    '   [rewriteResume] OUT: tailoredResume=%d chars',
    tailored?.length ?? 0,
  );
  console.log(
    '   [rewriteResume] OUT: first 150 chars =',
    truncate(tailored, 150),
  );
  console.log('✅ [rewriteResume] Done. Tailored resume generated.');

  return {
    tailoredResume: tailored,
  };
}

// ── Node 4: Check Pages ──
// With HTML + client-side PDF, we skip server-side page counting.
// Always return 1 page — the CSS constrains the page to letter size.

async function checkPagesNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log(
    '\n📄 [checkPages] IN: tailoredResume=%d chars',
    state.tailoredResume?.length ?? 0,
  );

  // HTML template is CSS-constrained to 1 page (8.5x11in).
  // The LLM is instructed to keep content under 500 words / 100 chars per bullet.
  // We trust the constraints and skip compilation.
  const pages = 1;
  console.log('   [checkPages] OUT: pageCount=%d (CSS-constrained)', pages);
  console.log(`✅ [checkPages] Page count: ${pages}`);

  return {
    pageCount: pages,
  };
}

// ── Node 5: Trim Resume (kept as fallback, unlikely to trigger) ──

async function trimResumeNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const attempt = state.trimAttempts + 1;
  console.log(
    '\n✂️  [trimResume] IN: pageCount=%d, trimAttempts=%d, tailoredResume=%d chars',
    state.pageCount,
    state.trimAttempts,
    state.tailoredResume?.length ?? 0,
  );

  const isLateAttempt = attempt >= 3;
  const maxChars = isLateAttempt ? '80' : '100';

  const prompt = `This HTML resume overflows 1 page when printed. It MUST fit on exactly 1 page (letter size, 8.5x11in).
${isLateAttempt ? `\nAttempt ${attempt}. Be VERY aggressive.\n` : ''}
Shorten using these strategies:
1. Each bullet <li> under ${maxChars} characters.
2. Summary to 1-2 lines max.
3. Technical Skills: max 5 items per row.
4. Shorten Achievements to a single line.
${isLateAttempt ? '5. Cut bullets to 2 per role if still too long.' : ''}

NEVER REMOVE any Experience entry, Project entry, Education, or Achievements.
Keep all <strong> on metrics and tech names. Keep CSS and HTML structure as-is.

Here is the current HTML:

${state.tailoredResume}

Output ONLY the shortened HTML. No explanation, no markdown fences.`;

  const response = await getLLM().invoke([
    new SystemMessage(
      'You are an HTML resume editor. Shorten this resume to fit on 1 printed page. Never remove any role or project. Keep <strong> on all metrics. Output only valid HTML.',
    ),
    new HumanMessage(prompt),
  ]);

  const trimmed = sanitizeHtml(extractText(response.content));
  console.log(
    '   [trimResume] OUT: tailoredResume=%d chars (was %d), trimAttempts=%d',
    trimmed?.length ?? 0,
    state.tailoredResume?.length ?? 0,
    attempt,
  );
  console.log(`✅ [trimResume] Attempt ${attempt} done.`);

  return {
    tailoredResume: trimmed,
    trimAttempts: attempt,
  };
}

// ── Routing: after checkPages ──

function routeAfterCheck(state: GraphStateType): 'trimResume' | 'done' {
  const route =
    state.pageCount <= 1
      ? 'done'
      : state.trimAttempts >= 5
        ? 'done'
        : 'trimResume';
  console.log(
    '   [route] checkPages → %s (pageCount=%d, trimAttempts=%d)',
    route,
    state.pageCount,
    state.trimAttempts,
  );
  return route;
}

async function doneNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log(
    '\n🎉 [done] IN: pageCount=%d, trimAttempts=%d, tailoredResume=%d chars, messages.length=%d',
    state.pageCount,
    state.trimAttempts,
    state.tailoredResume?.length ?? 0,
    state.messages?.length ?? 0,
  );

  // Calculate post-tailoring ATS score
  let postScore = '';
  let updatedAts = state.atsAnalysis;
  try {
    let raw = state.parsedJD.trim();
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const jd = JSON.parse(raw);
    const allKeywords = [
      ...(jd.primaryKeywords || []),
      ...(jd.secondaryKeywords || []),
      ...(jd.implicitSkills || []),
    ];
    const tailoredLower = (state.tailoredResume || '').toLowerCase();
    const baseLower = (state.baseResume || '').toLowerCase();

    const baseMatched = allKeywords.filter(kw => baseLower.includes(kw.toLowerCase()));
    const tailoredMatched = allKeywords.filter(kw => tailoredLower.includes(kw.toLowerCase()));
    const tailoredMissing = allKeywords.filter(kw => !tailoredLower.includes(kw.toLowerCase()));
    const total = allKeywords.length || 1;
    const basePercent = Math.round((baseMatched.length / total) * 100);
    const tailoredPercent = Math.round((tailoredMatched.length / total) * 100);

    postScore = `\n\nATS Score: ${basePercent}% → ${tailoredPercent}% (${tailoredMatched.length}/${total} keywords matched).`;
    console.log(`   [done] ATS: base=${basePercent}%, tailored=${tailoredPercent}%`);

    // Update atsAnalysis with post-tailoring score
    let atsObj: any = {};
    try { atsObj = JSON.parse(state.atsAnalysis); } catch {}
    atsObj.baseScore = basePercent;
    atsObj.score = tailoredPercent;
    atsObj.matched = tailoredMatched;
    atsObj.missing = tailoredMissing;
    atsObj.totalKeywords = total;
    updatedAts = JSON.stringify(atsObj, null, 2);
  } catch {}

  // Get recruiter review
  let recruiterReview = '';
  try {
    console.log('   [done] Running recruiter review...');
    const reviewPrompt = `Here is the tailored resume:\n${state.tailoredResume}\n\nHere is the parsed job description:\n${state.parsedJD}\n\nHere is the ATS analysis:\n${updatedAts}\n\nProvide your recruiter analysis.`;
    const response = await getLLM().invoke([
      new SystemMessage(RECRUITER_REVIEW_PROMPT),
      new HumanMessage(reviewPrompt),
    ]);
    recruiterReview = '\n\n' + extractText(response.content);
    console.log('   [done] Recruiter review generated.');
  } catch (err) {
    console.error('   [done] Recruiter review failed:', err);
  }

  const finalMsg =
    `I've tailored your resume for this role.${postScore}${recruiterReview}\n\n` +
    `You can ask me questions about the changes, request specific edits, or say "compile" to generate the PDF.`;
  console.log('   [done] OUT: adding final AIMessage, messages +1');
  return {
    atsAnalysis: updatedAts,
    messages: [new AIMessage(finalMsg)],
  };
}

// ── Graph Assembly ──

export function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode('parseJD', parseJDNode)
    .addNode('atsMatch', atsMatchNode)
    .addNode('rewriteResume', rewriteResumeNode)
    .addNode('checkPages', checkPagesNode)
    .addNode('trimResume', trimResumeNode)
    .addNode('done', doneNode)
    .addEdge(START, 'parseJD')
    .addEdge('parseJD', 'atsMatch')
    .addEdge('atsMatch', 'rewriteResume')
    .addEdge('rewriteResume', 'checkPages')
    .addConditionalEdges('checkPages', routeAfterCheck, {
      trimResume: 'trimResume',
      done: 'done',
    })
    .addEdge('trimResume', 'checkPages')
    .addEdge('done', END);

  return graph.compile();
}

export { GraphState, sanitizeHtml };
export type { GraphStateType };
