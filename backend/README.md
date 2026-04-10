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
# Optional: require login in production only (NODE_ENV=production). Local `npm run dev` and docker-compose ignore it.
ADMIN_PASSWORD=your_secret_password
SESSION_SECRET=random_secret_for_cookies
# Optional: absolute path, or path relative to process cwd — always re-read from disk (overrides bundled resumes/base-resume.tex). Use with a Docker volume so edits on the host are picked up.
# BASE_RESUME_PATH=/data/base-resume.tex
```

### 3. Base resume

Place your LaTeX resume at `resumes/base-resume.tex`. The app uses `altacv` document class.

**Always the latest on disk:** tailoring, chat, and `/session` reload `base-resume.tex` from that file on each run (in-memory/DB snapshots are not used when the file exists). Set `BASE_RESUME_PATH` if the file lives elsewhere (e.g. a mounted volume in Docker).

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
   - **Root Directory**: `resume-tailor/backend`
   - **Runtime**: **Docker**
   - **Instance Type**: Free
4. Add environment variables:
   - `GOOGLE_API_KEY` (required, mark as secret)
   - `PORT` = `3000` (optional; Render sets this automatically)
5. Deploy. The app will be live at `https://your-service.onrender.com`.

**Note:** On Render free tier, the service spins down after 15 min idle (~1 min to wake). SQLite data is ephemeral (lost on redeploy/restart).

### LaTeX / Tectonic on Render

- The **Dockerfile** installs **native** Tectonic per CPU: **amd64** → `x86_64-unknown-linux-gnu`, **arm64** (Apple Silicon) → `aarch64-unknown-linux-musl`. Pre-warm should print `Tectonic pre-warm: OK` when the compile succeeds.
- **Do not** run `docker run --platform linux/amd64` on Apple Silicon for this app: QEMU emulating amd64 often breaks Tectonic with **`free(): invalid pointer` / Aborted**. Use the default **arm64** image locally; Render stays on **amd64** natively.
- **HTTP compile** uses a **5-minute** default timeout (`TECTONIC_TIMEOUT_MS`, default `300000`). Older code used 30s, which often failed when Tectonic had to download bundles on a cold filesystem.
- If the UI still shows “LaTeX compilation failed”, check the **terminal** where `npm run dev` runs: the full Tectonic log is printed. In **development** the failing source is also saved as `resumes/output/debug-failed-compile.tex` (or `debug-failed-compile-base.tex`). Common local causes: **`tectonic` not installed or not on PATH** (install: `brew install tectonic`), or **invalid LaTeX** in the tailored resume from the model (open the debug `.tex` and fix, or use Chat to correct).
- In the browser **Network** tab, the failed `/compile` response JSON includes a `details` field; the alert now includes it when possible.
- Render may still terminate very long requests at the **platform** limit; keeping the Docker cache warm avoids multi-minute compiles.

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
