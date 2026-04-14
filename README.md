# Treelogy Wellness Truth Engine — Backend API

Clinical-grade wellness AI backend with RAG, guardrails, PII sanitization, and fact-checking.

**Base URL:** `https://backend-cs-treelogy.vercel.app`

---

## API Endpoints

### 1. Health Check

```
GET /api/health
```

**Response** `200`

```json
{
  "status": "healthy",
  "service": "Treelogy Wellness Truth Engine",
  "version": "1.0.0",
  "timestamp": "2026-04-14T10:00:00.000Z"
}
```

---

### 2. Ask a Wellness Question

```
POST /api/query
```

**Headers**

| Header | Type | Required | Description |
|---|---|---|---|
| `Content-Type` | `string` | Yes | Must be `application/json` |
| `x-user-id` | `string` | No | Optional user identifier for audit logging |

**Request Body**

```json
{
  "question": "What are the benefits of intermittent fasting?"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `question` | `string` | Yes | 3–2000 characters |

**Response** `200`

```json
{
  "answer": "Intermittent fasting has several evidence-based benefits...\n\n---\n**Disclaimer:** This information is provided for educational and wellness purposes only...",
  "sources": [
    {
      "name": "WHO Nutrition Guidelines",
      "reference": "https://example.com/source"
    }
  ],
  "sourceType": "internal | web | none",
  "confidence": 0.85,
  "verified": true,
  "cached": false,
  "responseTimeMs": 2340
}
```

| Field | Type | Description |
|---|---|---|
| `answer` | `string` | AI-generated answer with medical disclaimer appended |
| `sources` | `array` | List of sources used to generate the answer |
| `sources[].name` | `string` | Source document or article name |
| `sources[].reference` | `string` | URL or document path |
| `sourceType` | `string` | `"internal"` (knowledge base), `"web"` (Tavily search), or `"none"` |
| `confidence` | `number` | Similarity score (0–1). Higher = more confident from internal knowledge |
| `verified` | `boolean` | Whether the answer passed the fact-check loop |
| `cached` | `boolean` | Whether the response was served from cache |
| `responseTimeMs` | `number` | Processing time in milliseconds (not present when cached) |

**Error Responses**

| Status | Body |
|---|---|
| `400` | `{ "error": "A \"question\" string is required." }` |
| `400` | `{ "error": "Question must be at least 3 characters." }` |
| `400` | `{ "error": "Question must not exceed 2000 characters." }` |
| `429` | `{ "error": "Too many requests. Please try again later.", "retryAfterMs": 60000 }` |
| `500` | `{ "error": "An internal error occurred while processing your question." }` |

---

### 3. Ask a Question (Streaming / SSE)

```
POST /api/query/stream
```

**Headers & Request Body:** Same as `POST /api/query`

**Response:** Server-Sent Events (SSE) stream with `Content-Type: text/event-stream`

**SSE Events (in order):**

```
event: metadata
data: {"sourceType":"internal","confidence":0.85,"sourceCount":3}

event: token
data: "Intermittent"

event: token
data: " fasting"

event: token
data: " has"

...

event: sources
data: [{"name":"WHO Guidelines","reference":"https://example.com"}]

event: disclaimer
data: "\n\n---\n**Disclaimer:** This information is provided for educational..."

event: done
data: null
```

| Event | Data Type | Description |
|---|---|---|
| `metadata` | `object` | Source type, confidence score, and source count |
| `token` | `string` | Individual text token of the streamed answer |
| `sources` | `array` | Source references (same format as standard query) |
| `disclaimer` | `string` | Medical disclaimer text |
| `done` | `null` | Signals end of stream |
| `error` | `object` | Error if stream processing fails: `{ "error": "..." }` |

**Frontend SSE Example:**

```javascript
const response = await fetch("https://backend-cs-treelogy.vercel.app/api/query/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "Benefits of meditation?" }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      const eventType = line.slice(7);
    }
    if (line.startsWith("data: ")) {
      const data = JSON.parse(line.slice(6));
      // Handle based on eventType
    }
  }
}
```

---

### 4. Ingest a PDF Document

```
POST /api/ingest/file
```

**Headers**

| Header | Type | Required |
|---|---|---|
| `Content-Type` | `multipart/form-data` | Yes |

**Request Body:** `multipart/form-data`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `document` | `file` | Yes | PDF only, max 20MB |

**Response** `200`

```json
{
  "message": "Successfully ingested \"nutrition-guide.pdf\"",
  "chunks": 42,
  "pages": 15
}
```

**Error Responses**

| Status | Body |
|---|---|
| `400` | `{ "error": "A PDF file is required." }` |
| `400` | `{ "error": "Only PDF files are accepted." }` |
| `400` | `{ "error": "File must be under 20MB." }` |
| `429` | `{ "error": "Ingestion rate limit exceeded. Max 10 per hour." }` |
| `500` | `{ "error": "Failed to ingest document.", "details": "..." }` |

---

### 5. Ingest All PDFs from Server Directory

```
POST /api/ingest/directory
```

**Request Body:** None

**Response** `200`

```json
{
  "message": "Ingested 3 documents with 128 total chunks.",
  "documents": [
    { "file": "nutrition-guide.pdf", "chunks": 42, "pages": 15 },
    { "file": "exercise-handbook.pdf", "chunks": 56, "pages": 22 },
    { "file": "sleep-research.pdf", "chunks": 30, "pages": 10 }
  ]
}
```

---

### 6. Clear Vector Store

```
DELETE /api/ingest
```

**Request Body:** None

**Response** `200`

```json
{
  "message": "Knowledge store cleared successfully."
}
```

---

### 7. Get Audit Logs

```
GET /api/audit
```

**Query Parameters**

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `sourceType` | `string` | No | — | Filter by `"internal"`, `"web"`, or `"none"` |
| `verified` | `string` | No | — | Filter by `"true"` or `"false"` |
| `limit` | `number` | No | `50` | Max number of logs to return |
| `offset` | `number` | No | `0` | Pagination offset |

**Example:** `GET /api/audit?sourceType=web&verified=true&limit=10&offset=0`

**Response** `200`

```json
{
  "count": 10,
  "logs": [
    {
      "question": "What are the benefits of intermittent fasting?",
      "answer": "...",
      "sourceType": "web",
      "confidence": 0.65,
      "verified": true,
      "sources": [...],
      "userId": "user-123",
      "responseTimeMs": 2340,
      "timestamp": "2026-04-14T10:00:00.000Z"
    }
  ]
}
```

---

## Rate Limits

| Endpoint | Window | Max Requests |
|---|---|---|
| `POST /api/query` | 60 seconds | 20 |
| `POST /api/query/stream` | 60 seconds | 20 |
| `POST /api/ingest/*` | 1 hour | 10 |

---

## Security Features

- **PII Sanitization**: Emails, phone numbers, SSNs, and credit card numbers are automatically redacted before reaching the AI model
- **Helmet**: HTTP security headers enabled
- **CORS**: Cross-origin requests enabled (all origins)
- **Input Validation**: Question length (3–2000 chars), PDF-only file uploads, file size limits

---

## Architecture

```
Frontend Request
    │
    ▼
[Express API] ─── Rate Limiter ─── PII Sanitizer ─── Validator
    │
    ▼
[RAG Orchestrator]
    ├── Semantic Search (Supabase pgvector)
    │       │
    │       ├── confidence >= 0.75 → Use internal knowledge
    │       └── confidence < 0.75  → Tavily web search fallback
    │
    ├── LLM Generation (Hugging Face / Mistral)
    ├── Fact-Check Loop (second LLM pass)
    └── Medical Disclaimer
    │
    ▼
[Response] + Audit Log + Cache (Redis)
```
