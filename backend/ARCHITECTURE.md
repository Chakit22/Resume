# Resume Tailor — Architecture

This document describes the architecture of the Resume Tailor application: the LangGraph pipeline, how `server.ts` and `agent.ts` work together, and the data flow.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (Browser)                                  │
│  Sidebar (threads) │ Input (URL/JD) │ Results │ Chat │ Cover Letter │ Download  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              server.ts (Express)                                 │
│  jobQueue │ sessions Map │ POST /tailor │ GET /session │ POST /chat │ etc.      │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
            processQueue()        sessions.get()       Manual chat
                    │                   │                   │
                    ▼                   │                   │
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              agent.ts (LangGraph)                                │
│  buildGraph() → parseJD → atsMatch → rewriteResume → checkPages → trim/done     │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              db.ts + SQLite                                      │
│  jobs │ sessions │ messages                                                      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Thread / Session Model

**Thread ID = Session ID = Job ID** — a single UUID used everywhere.

| Concept   | Where it lives | Purpose                                      |
|----------|----------------|----------------------------------------------|
| Job      | `jobQueue[]`   | Queue entry: status, label, JD, etc.         |
| Session  | `sessions` Map | Completed state: tailored resume, messages   |
| Thread   | Frontend       | UI representation of a job/session           |

---

## 2. LangGraph Pipeline (agent.ts)

### Graph Structure

```
                    ┌─────────────┐
                    │   START     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  parseJD    │  Node 1
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  atsMatch   │  Node 2
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │rewriteResume│  Node 3
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ checkPages  │  Node 4
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │   routeAfterCheck()     │
              │  pageCount≤1? trim≥5?    │
              └────────────┬────────────┘
                    ┌─────┴─────┐
                    │           │
              done  │     trimResume  (loop back to checkPages)
                    │           │
                    ▼           ▼
              ┌─────────┐  ┌─────────────┐
              │  done    │  │  checkPages │
              └────┬────┘  └──────┬──────┘
                   │              │
                   ▼              │
              ┌─────────┐        │
              │   END   │◀───────┘
              └─────────┘
```

### GraphState (Shared State)

| Field          | Type            | Reducer              | Purpose                                  |
|----------------|-----------------|----------------------|------------------------------------------|
| `messages`     | `BaseMessage[]` | Append (`[...curr, ...update]`) | System + user messages          |
| `baseResume`   | `string`        | Replace              | Original LaTeX resume                    |
| `parsedJD`     | `string`        | Replace              | JSON from parseJD                        |
| `atsAnalysis`  | `string`        | Replace              | JSON: score, matched, missing             |
| `tailoredResume` | `string`      | Replace              | Rewritten LaTeX                          |
| `pageCount`    | `number`        | Replace              | Pages after compile                      |
| `trimAttempts` | `number`        | Replace              | Trim loop counter                        |

---

## 3. Node-by-Node Flow

### Initial Invocation (from server.ts)

```ts
graph.invoke({
  messages: [new HumanMessage(next.jd)],  // JD text as first message
  baseResume,                             // Loaded from base-resume.tex
});
```

---

### Node 1: parseJD

| IN (from state)      | OUT (returned) |
|----------------------|----------------|
| `messages[0].content` = JD text | `parsedJD` = JSON string |
| `baseResume`         | `messages` += `[AIMessage("[System] Job description parsed successfully.")]` |

**LLM call:** `[SystemMessage(PARSE_JD_PROMPT), HumanMessage(jdText)]` → structured JSON.

**Edge:** `parseJD` → `atsMatch`

---

### Node 2: atsMatch

| IN (from state) | OUT (returned) |
|-----------------|----------------|
| `parsedJD`      | `atsAnalysis` = JSON `{ score, matched, missing, suggestions, jobTitle, company }` |
| `baseResume`    | `messages` += `[AIMessage("[System] ATS Match Score: X%...")]` |

**LLM call:** None. Pure logic: parse `parsedJD`, compare keywords to `baseResume`.

**Edge:** `atsMatch` → `rewriteResume`

---

### Node 3: rewriteResume

| IN (from state)   | OUT (returned)   |
|-------------------|------------------|
| `baseResume`      | `tailoredResume` = new LaTeX |
| `atsAnalysis`     |                  |
| `parsedJD`        |                  |

**LLM call:** `[SystemMessage(REWRITE_RESUME_PROMPT), HumanMessage(prompt)]` where `prompt` = baseResume + atsAnalysis + parsedJD. Does **not** use `state.messages`.

**Edge:** `rewriteResume` → `checkPages`

---

### Node 4: checkPages

| IN (from state)   | OUT (returned) |
|-------------------|----------------|
| `tailoredResume`  | `pageCount` = 1 or 2+ |

**LLM call:** None. Compiles LaTeX with Tectonic and reads page count from log.

**Edge:** Conditional → `trimResume` or `done`

---

### Routing: routeAfterCheck

```ts
if (pageCount <= 1) → done
else if (trimAttempts >= 5) → done  // give up
else → trimResume
```

---

### Node 5: trimResume

| IN (from state)     | OUT (returned)        |
|---------------------|------------------------|
| `tailoredResume`    | `tailoredResume` = shortened LaTeX |
| `pageCount`         | `trimAttempts` = attempt + 1       |
| `trimAttempts`      |                        |
| `parsedJD`          |                        |

**LLM call:** `[SystemMessage(trim instructions), HumanMessage(prompt)]` with current LaTeX and page count.

**Edge:** `trimResume` → `checkPages` (loop)

---

### Node 6: done

| IN (from state) | OUT (returned) |
|-----------------|----------------|
| `pageCount`, `trimAttempts`, etc. | `messages` += `[AIMessage("I've tailored your resume...")]` |

**LLM call:** None.

**Edge:** `done` → `END`

---

## 4. server.ts ↔ agent.ts

### When agent.ts is used

| Trigger        | Location in server.ts | What happens |
|----------------|------------------------|--------------|
| New job        | `processQueue()`       | `graph.invoke({ messages: [HumanMessage(jd)], baseResume })` |
|                |                        | Result stored in `sessions.set(next.id, result)` |

**Agent is invoked once per job** during tailoring. It is not used for chat.

### After the graph finishes

```ts
sessions.set(next.id, result);   // In-memory
persistSession(next.id, result); // SQLite: sessions + messages tables
```

### Chat (no LangGraph)

Chat is handled entirely in `server.ts`:

1. `session = sessions.get(sessionId)`
2. Append user message: `updatedMessages = [...session.messages, HumanMessage(message)]`
3. Call LLM with `[SystemMessage(context), ...conversation]`
4. Append AI response: `allMessages = [...updatedMessages, AIMessage(content)]`
5. Update session: `sessions.set(sessionId, { ...session, messages: allMessages })`
6. Persist via `persistSession()`

---

## 5. Data Flow Summary

```
POST /tailor
    → jobQueue.push(job)
    → processQueue()
        → graph.invoke({ messages: [HumanMessage(jd)], baseResume })
        → parseJD → atsMatch → rewriteResume → checkPages → [trim loop] → done
        → sessions.set(id, result)
        → persistSession(id, result)

GET /session/:id
    → sessions.get(id) or hydrate from DB
    → return tailoredResume, atsAnalysis, messages, etc.

POST /chat
    → session = sessions.get(sessionId)
    → llm.invoke([SystemMessage(...), ...session.messages, HumanMessage(msg)])
    → sessions.set(sessionId, { ...session, messages: allMessages })
    → persistSession()
```

---

## 6. Persistence (db.ts)

| Table     | Key        | Purpose                                      |
|-----------|------------|----------------------------------------------|
| `jobs`    | `id`       | Job metadata: status, label, jd              |
| `sessions`| `id`       | Tailored resume, parsed JD, ATS, cover letter |
| `messages`| `session_id` | Conversation history (seq, type, content)  |

On startup, `hydrateFromDb()` loads jobs and sessions into `jobQueue` and `sessions` Map.
