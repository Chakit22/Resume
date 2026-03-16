# Resume Tailor

A **LangGraph-powered** application that tailors LaTeX resumes to job descriptions. Submit a job URL or paste a JD, and the agent parses it, analyzes ATS match, rewrites your resume, and ensures it fits on one page.

---

## Features

- **Job scraping** — Paste a URL or job description text
- **ATS analysis** — Matched/missing keywords, score
- **Resume tailoring** — LLM rewrites your LaTeX resume for the role
- **One-page constraint** — Automatic trim loop if over 1 page
- **Cover letter** — Generate, edit, save, download as PDF/DOCX
- **Chat** — Ask questions, request edits after tailoring
- **SQLite persistence** — Sessions and messages survive restarts

---

## Architecture

### server.ts + agent.ts

| Component     | Role                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| **server.ts** | Express API, job queue, session storage, chat handler, cover letter, compile/download |
| **agent.ts**  | LangGraph pipeline: parse JD → ATS match → rewrite → check pages → trim (loop) → done |

**Flow:**

1. **POST /tailor** — Enqueues a job, returns `sessionId`
2. **processQueue()** — Picks next job, calls `graph.invoke()` with JD + base resume
3. **agent.ts** — Runs the pipeline; result stored in `sessions` Map
4. **persistSession()** — Saves to SQLite (sessions + messages)
5. **POST /chat** — Manual handling: appends messages, invokes LLM, updates session (no LangGraph)

The **agent runs once per job** during tailoring. Chat is handled manually in the server.

### LangGraph Pipeline (agent.ts)

```
START → parseJD → atsMatch → rewriteResume → checkPages
                                    │
                    ┌───────────────┴───────────────┐
                    │  pageCount ≤ 1?  trimAttempts ≥ 5?  │
                    └───────────────┬───────────────┘
                           done     │     trimResume → checkPages (loop)
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full node-by-node flow, state schema, and data flow.

---

## Setup

### 1. Install dependencies

```bash
cd resume-tailor/backend
npm install
```

### 2. Environment

Create `.env`:

```env
GOOGLE_API_KEY=your_google_api_key
PORT=3000
```

### 3. Base resume

Place your LaTeX resume at `resumes/base-resume.tex`. The app uses `altacv` document class.

### 4. Run

```bash
npm run dev
```

Open http://localhost:3000

---

## Deploy on Render (Free Tier)

1. Push the repo to GitHub/GitLab/Bitbucket.
2. In [Render Dashboard](https://dashboard.render.com/), click **New > Web Service**.
3. Connect your repo and configure:
   - **Root Directory**: `resume-tailor` (so `render.yaml` is found)
   - **Runtime**: **Docker**
   - **Instance Type**: Free
4. Add environment variables:
   - `GOOGLE_API_KEY` (required, mark as secret)
   - `PORT` = `3000` (optional; Render sets this automatically)
5. Deploy. The app will be live at `https://your-service.onrender.com`.

**Note:** On Render free tier, the service spins down after 15 min idle (~1 min to wake). SQLite data is ephemeral (lost on redeploy/restart).

---

## API

| Endpoint                      | Method | Purpose                        |
| ----------------------------- | ------ | ------------------------------ |
| `/`                           | GET    | Web UI                         |
| `/tailor`                     | POST   | Submit job `{ url? \| jd? }`   |
| `/sessions`                   | GET    | List jobs for sidebar          |
| `/session/:id`                | GET    | Full session data              |
| `/chat`                       | POST   | Chat `{ sessionId, message }`  |
| `/cover-letter`               | POST   | Generate cover letter          |
| `/cover-letter/save`          | POST   | Save edited cover letter       |
| `/cover-letter/download/pdf`  | POST   | Download as PDF                |
| `/cover-letter/download/docx` | POST   | Download as DOCX               |
| `/compile`                    | POST   | Compile tailored resume to PDF |
| `/compile-base`               | POST   | Compile base resume to PDF     |

---

## Project structure

```
resume-tailor/backend/
├── src/
│   ├── server.ts    # Express, queue, sessions, chat, endpoints
│   ├── agent.ts     # LangGraph pipeline
│   ├── prompts.ts   # LLM prompts
│   └── db.ts        # SQLite CRUD
├── resumes/
│   ├── base-resume.tex
│   └── output/
├── data/
│   └── resume-tailor.db
├── ARCHITECTURE.md  # Detailed architecture
└── README.md
```

---

## License

MIT
