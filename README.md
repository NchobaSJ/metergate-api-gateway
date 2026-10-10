# MeterGate

A lightweight API gateway built with Fastify and TypeScript.

## Phase 1 — Simple Gateway

- Reverse proxy
- Request IDs
- Header filtering (hop-by-hop + identity header stripping)
- Upstream timeout handling
- Structured logging
- Mock upstream for testing

## Requirements

- Node.js 20+
- npm

## Setup

\`\`\`bash
npm install
\`\`\`

## Run

Terminal 1 — mock upstream on port 4000:

\`\`\`bash
npm run mock
\`\`\`

Terminal 2 — gateway on port 3000:

\`\`\`bash
npm run dev
\`\`\`

## Test

\`\`\`bash
curl http://localhost:3000/health
curl http://localhost:3000/hello
\`\`\`

## Notes

- `UPSTREAM_URL` defaults to `http://127.0.0.1:4000`.
  Use `127.0.0.1`, not `localhost`, to avoid IPv4/IPv6 mismatches.
