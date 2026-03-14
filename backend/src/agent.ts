import { Annotation, StateGraph, END, START } from '@langchain/langgraph';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PARSE_JD_PROMPT,
  REWRITE_RESUME_PROMPT,
  CHAT_SYSTEM_PROMPT,
} from './prompts.js';

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

function stripForbiddenSkills(latex: string): string {
  return latex
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.includes('\\cvtag')) return true;
      const lower = line.toLowerCase();
      if (lower.includes('communication')) return false;
      if (lower.includes('ai agents')) return false;
      if (lower.includes('sdlc')) return false;
      if (lower.includes('agile')) return false;
      if (lower.includes('bash') && lower.includes('shell')) return false;
      return true;
    })
    .join('\n');
}

function sanitizeLatex(latex: string): string {
  let clean = latex.trim();
  clean = clean.replace(/^```(?:latex)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Remove forbidden skills (communication, etc.)
  clean = stripForbiddenSkills(clean);

  // Fix unescaped & and % on all content lines.
  // Skip lines that are LaTeX commands/environments where & or % have special meaning.
  const safeLinePatterns = [
    /^\\(begin|end|documentclass|usepackage|geometry|definecolor|colorlet|renewcommand|newcommand|columnratio|paracol|switchcolumn)/,
    /^%/, // already a comment
    /^\s*$/, // blank
    /\\makecvheader/,
    /\\name\{/,
    /\\personalinfo/,
  ];

  clean = clean
    .split('\n')
    .map((line) => {
      if (safeLinePatterns.some((p) => p.test(line.trim()))) return line;

      // Fix unescaped & (but not \& which is already escaped, and not inside \href{...})
      line = line.replace(/(?<!\\)&/g, '\\&');

      // Fix unescaped % (but not \% which is already escaped, and not at start of line = comment)
      if (!line.trim().startsWith('%')) {
        line = line.replace(/(?<!\\)%/g, '\\%');
      }

      return line;
    })
    .join('\n');

  return clean;
}

function compileAndCountPages(latex: string): number {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write tex file in resumes/ dir (same dir as altacv.cls) so tectonic finds it
  const texPath = path.join(RESUMES_DIR, '_pagecheck.tex');
  const logPath = path.join(OUTPUT_DIR, '_pagecheck.log');

  let clean = sanitizeLatex(latex);
  clean = clean.replace(
    /\\usepackage\[.*?\]\{hyperref\}/g,
    '% hyperref loaded by altacv.cls',
  );
  clean = clean.replace(
    /\\usepackage\{hyperref\}/g,
    '% hyperref loaded by altacv.cls',
  );

  fs.writeFileSync(texPath, clean);

  try {
    execSync(
      `tectonic "${texPath}" --outdir "${OUTPUT_DIR}" --keep-logs --keep-intermediates`,
      { timeout: 30000, cwd: RESUMES_DIR, stdio: 'pipe' },
    );
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    console.log('⚠️  [checkPages] Compilation failed:', stderr.slice(-200));
    // Return 2 on failure so the trim loop retries (returning 1 would falsely skip trimming)
    return 2;
  }

  try {
    const log = fs.readFileSync(logPath, 'utf-8');
    const match = log.match(/Output written on .+\((\d+) page/);
    if (match) return parseInt(match[1], 10);
  } catch {}

  // If we can't read the log, assume it needs trimming
  return 2;
}

// ── Node 1: Parse JD ──

async function parseJDNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const lastMessage = state.messages[state.messages.length - 1];
  const jdText = lastMessage.content as string;

  console.log('\n🔍 [parseJD] Parsing job description...');

  const response = await getLLM().invoke([
    new SystemMessage(PARSE_JD_PROMPT),
    new HumanMessage(jdText),
  ]);

  const parsed = extractText(response.content);
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
  console.log('\n📊 [atsMatch] Analyzing ATS match...');

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
  console.log('\n✍️  [rewriteResume] Rewriting resume...');

  const prompt = `Here is the original LaTeX resume:

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

  const tailored = sanitizeLatex(extractText(response.content));
  console.log('✅ [rewriteResume] Done. Tailored resume generated.');

  return {
    tailoredResume: tailored,
  };
}

// ── Node 4: Check Pages ──
// Compiles the LaTeX and counts pages. Pure function, no LLM.

async function checkPagesNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log('\n📄 [checkPages] Compiling to check page count...');

  const pages = compileAndCountPages(state.tailoredResume);
  console.log(`✅ [checkPages] Page count: ${pages}`);

  return {
    pageCount: pages,
  };
}

// ── Node 5: Trim Resume ──
// If the resume is >1 page, ask the LLM to aggressively shorten it.

async function trimResumeNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const attempt = state.trimAttempts + 1;
  console.log(
    `\n✂️  [trimResume] Attempt ${attempt} — currently ${state.pageCount} pages, need 1...`,
  );

  const isLateAttempt = attempt >= 3;

  // Check if JD mentions problem solving / algorithmic skills — if so, preserve Coding Profiles
  const jdText = (state.parsedJD || '').toLowerCase();
  const keepCodingProfiles = /problem\s*solving|algorithmic|data\s*structures|coding\s*challenges|leetcode|competitive\s*programming|codechef|hackerrank/.test(jdText);

  const prompt = `This LaTeX resume compiles to ${state.pageCount} pages. It MUST fit on exactly 1 page.
${isLateAttempt ? `\nThis is attempt ${attempt}. Previous attempts did NOT reduce it enough. You MUST be much more aggressive this time.\n` : ''}
Job description excerpt (for context): ${jdText.slice(0, 400)}...
${keepCodingProfiles ? '\nCRITICAL: The job description mentions problem solving, algorithmic skills, or coding challenges. DO NOT remove the Coding Profiles section. Preserve it.\n' : ''}

Shorten it by condensing CONTENT only. Use these strategies${isLateAttempt ? ' — apply ALL of them aggressively' : ' IN ORDER'}:
1. MANDATORY: Keep exactly 3 \\item bullet points per \\cvevent. Do NOT reduce to 2. Only cut to ${isLateAttempt ? '1' : '2'} per role as a last resort if still over 1 page after all other strategies.
2. Make each bullet point a single concise line — under ${isLateAttempt ? '90' : '120'} characters per \\item
3. Remove Certificates section if it exists. ${keepCodingProfiles ? 'DO NOT remove Coding Profiles — keep it.' : 'Remove Coding Profiles section if it exists.'}
4. Shorten the skills/tags list — keep only ${isLateAttempt ? '5-6' : '8-10'} most relevant \\cvtag entries. Only tech stack (Next.js, React, AWS) or Problem Solving/LLMs. REMOVE any \\cvtag{communication}, \\cvtag{Communication}, \\cvtag{SDLC}, \\cvtag{Agile}, \\cvtag{bash/Shell scripting} — delete those lines entirely.
5. Reduce ALL \\vspace values (e.g. \\vspace{0.3cm} → \\vspace{0.1cm})
6. Shorten achievement bullet points to one line each${isLateAttempt ? '\n7. Remove the Projects section if it exists\n8. Remove the Achievements section if needed' : ''}

ABSOLUTELY FORBIDDEN — NEVER DO THESE:
- NEVER remove any experience/position (\\cvevent). Every single role MUST remain.
- NEVER remove any \\divider between roles.
- NEVER remove the Education or Experience sections.

PRESERVE THE DESIGN: Keep all colors, fonts, \\divider commands, layout structure, section styling, and visual elements exactly as they are. Do NOT remove or change \\cvsection, \\cvevent, \\divider, theme options, or any styling.

PREVENT HORIZONTAL OVERFLOW: The resume uses a two-column layout. Keep bullet text short. Escape special LaTeX characters: & → \\&, % → \\%, $ → \\$, # → \\#, _ → \\_.

Here is the current LaTeX:

${state.tailoredResume}

Output ONLY the shortened LaTeX. No explanation, no markdown fences.`;

  const response = await getLLM().invoke([
    new SystemMessage(
      'You are a LaTeX resume editor. Shorten this resume to fit on 1 page by condensing content only. NEVER remove any experience/position (\\cvevent) — every role must stay. Keep exactly 3 bullet points per role. Preserve the exact design — colors, fonts, dividers, layout. Keep bullet text under 120 chars. Skills: only tech stack or Problem Solving/LLMs — DELETE any \\cvtag{communication}, \\cvtag{SDLC}, \\cvtag{Agile}. Output only valid LaTeX.',
    ),
    new HumanMessage(prompt),
  ]);

  const trimmed = sanitizeLatex(extractText(response.content));
  console.log(`✅ [trimResume] Attempt ${attempt} done.`);

  return {
    tailoredResume: trimmed,
    trimAttempts: attempt,
  };
}

// ── Routing: after checkPages ──

function routeAfterCheck(state: GraphStateType): 'trimResume' | 'done' {
  if (state.pageCount <= 1) return 'done';
  if (state.trimAttempts >= 5) {
    console.log(
      '⚠️  [route] Max trim attempts reached, proceeding with current version.',
    );
    return 'done';
  }
  return 'trimResume';
}

// "done" node produces the final user-facing message with a summary of actual changes
async function doneNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log('\n🎉 [done] Finalizing resume...');
  const pageNote =
    state.pageCount <= 1
      ? 'The resume fits on 1 page.'
      : `Note: after ${state.trimAttempts} trim attempts, the resume is ${state.pageCount} pages.`;

  return {
    messages: [
      new AIMessage(
        `I've tailored your resume for this role. ${pageNote}` +
          `You can ask me questions about the changes, request specific edits, or say "compile" to generate the PDF.`,
      ),
    ],
  };
}

// ── Graph Assembly ──
// parseJD → atsMatch → rewriteResume → checkPages → (trim loop) → done → END

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

export { GraphState, sanitizeLatex };
export type { GraphStateType };
