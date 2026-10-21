# MeterGate

### A Billing-Aware API Gateway and API Monetization Platform

MeterGate is a multi-tenant API gateway designed to help developers
expose, protect, monitor, and monetize REST APIs through a single
managed entry point. It sits between API consumers and upstream
services, centralizing request authentication, traffic policies, usage
metering, analytics, and subscription billing.

> **Project status:** This README describes MeterGate as the completed
> target product. Replace any deployment-specific values and benchmark
> placeholders with results from the actual implementation before
> publishing them as verified facts.

------------------------------------------------------------------------

## Table of Contents

-   [Overview](#overview)
-   [Problem Statement](#problem-statement)
-   [Goals](#goals)
-   [Key Features](#key-features)
-   [Architecture](#architecture)
-   [Technology Stack](#technology-stack)
-   [Request Lifecycle](#request-lifecycle)
-   [Security Design](#security-design)
-   [Reliability and Failure
    Handling](#reliability-and-failure-handling)
-   [Observability](#observability)
-   [Data Model](#data-model)
-   [API Overview](#api-overview)
-   [Developer Dashboard and Portal](#developer-dashboard-and-portal)
-   [Project Structure](#project-structure)
-   [Prerequisites](#prerequisites)
-   [Configuration](#configuration)
-   [Local Development](#local-development)
-   [Docker Deployment](#docker-deployment)
-   [Testing and Quality Assurance](#testing-and-quality-assurance)
-   [Performance Reporting](#performance-reporting)
-   [Operational Guidance](#operational-guidance)
-   [Known Design Considerations](#known-design-considerations)
-   [Roadmap Extensions](#roadmap-extensions)
-   [Contributing](#contributing)
-   [License](#license)
-   [Acknowledgements](#acknowledgements)

------------------------------------------------------------------------

## Overview

Developers who offer APIs often need to build and maintain
authentication, API-key management, rate limiting, quotas, usage
tracking, customer plans, billing, logs, and analytics separately.
MeterGate consolidates these capabilities into a shared platform so API
providers can focus on the functionality of their services.

A provider registers an upstream API and defines how it should be
accessed. MeterGate exposes a controlled gateway endpoint to consumers,
authenticates each request, evaluates the applicable tenant and plan
policies, forwards permitted traffic to the upstream service, and
records usage for reporting and billing.

### Core value proposition

**Turn an ordinary REST API into a managed, measurable, and monetizable
API product without rebuilding the same infrastructure for every
service.**

### Typical use case

A developer operates a weather API and wants to offer:

-   A free plan with a limited monthly request allowance.
-   A paid developer plan with higher request limits and usage
    analytics.
-   A business plan with configurable quotas and team access.
-   Usage-based charges for customers who exceed included allowances.

MeterGate provides the gateway and management capabilities required to
support this model.

## Problem Statement

Operating a commercial API involves more than implementing HTTP
endpoints. Providers must secure credentials, prevent abuse, isolate
customers, measure consumption accurately, maintain service reliability,
and connect usage to commercial plans. Building these concerns
independently can lead to inconsistent policies, duplicated engineering
effort, and unreliable usage records.

MeterGate addresses this problem through a centralized gateway and
management platform.

## Goals

### Product goals

-   Route API traffic through a consistent gateway.
-   Authenticate consumers with securely managed API keys.
-   Associate requests with the correct tenant and registered API.
-   Enforce plan-based rate limits and monthly usage quotas.
-   Measure request volume and API performance.
-   Maintain durable usage records for analytics and billing.
-   Support subscription and usage-based billing workflows.
-   Provide a dashboard for managing APIs, keys, plans, and usage.
-   Expose operational health and performance metrics.

### Engineering goals

-   Use a typed, maintainable TypeScript codebase.
-   Keep gateway request processing efficient.
-   Use Redis for fast, shared counters and policy state.
-   Use PostgreSQL for durable relational data.
-   Process usage and billing work asynchronously where appropriate.
-   Make sensitive operations auditable.
-   Test concurrency, security boundaries, and infrastructure failures.
-   Deploy repeatably using containers and standard Linux
    infrastructure.

------------------------------------------------------------------------

## Key Features

### API gateway and reverse proxy

-   Forwards HTTP requests to configured upstream services.
-   Preserves supported methods, paths, query parameters, request
    bodies, and responses.
-   Adds a unique request identifier for traceability.
-   Applies connection and request timeouts.
-   Returns controlled gateway errors when an upstream is unavailable.
-   Removes hop-by-hop headers and untrusted identity headers before
    forwarding.
-   Supports a configurable upstream target.

### API-key authentication

-   Accepts API keys through the `Authorization: Bearer <API_KEY>`
    header.
-   Associates valid credentials with a tenant and its policies.
-   Stores a cryptographic representation of each key rather than the
    complete secret.
-   Supports key revocation, rotation, expiry, and descriptive metadata.
-   Uses Redis caching with a durable database fallback where
    configured.
-   Avoids writing API secrets to application logs.

### Tenant and API management

-   Organizes customer accounts into tenants.
-   Associates tenants with plans and registered APIs.
-   Supports tenant status management and tenant-scoped access controls.
-   Separates customer-owned configuration and usage data.

### Rate limiting and quotas

-   Applies configurable request limits by plan, tenant, or API.
-   Uses a distributed token-bucket strategy backed by Redis.
-   Uses atomic Redis operations, such as Lua scripts, to avoid race
    conditions across gateway instances.
-   Tracks monthly usage against configured quotas.
-   Supports warning thresholds, for example at 80% and 90%, and
    enforcement at 100%.
-   Returns useful rate-limit and quota metadata where applicable.

Example response headers:

``` http
X-RateLimit-Limit: 10000
X-RateLimit-Remaining: 2741
X-Usage-Month: 7259
X-Quota-Limit: 10000
X-Request-ID: req_example
```

Actual header names and semantics should remain consistent with the API
documentation.

### Usage metering

MeterGate tracks usage for analytics and commercial reporting. The data
model can include:

-   Total requests.
-   Successful and failed requests.
-   HTTP status-code distribution.
-   Endpoint-level usage.
-   Request duration and upstream latency.
-   Response bytes and bandwidth where measured.
-   Usage grouped by tenant, API, key, and billing period.

Fast counters are maintained in Redis where appropriate, while durable
aggregates and events are persisted to PostgreSQL through a controlled
processing workflow.

### Subscription billing

The billing layer is designed to integrate with Stripe for customers,
subscriptions, prices, invoices, and metered usage. Billing operations
are kept separate from the critical proxy path.

Webhook processing verifies signatures, identifies each event, and uses
idempotency controls so a repeated event does not apply the same
business operation more than once.

### Developer dashboard and portal

The management interface brings together:

-   Overview metrics and usage summaries.
-   Registered APIs and upstream configuration.
-   API-key creation, listing, revocation, and rotation.
-   Plan and quota management.
-   Usage history and analytics.
-   Subscription, invoice, and payment status.
-   Account and team settings.
-   API documentation and an interactive API exploration experience,
    where enabled.

### Observability

-   Structured application logs with request IDs.
-   Health and readiness endpoints.
-   Prometheus-compatible operational metrics.
-   Grafana dashboards for traffic, errors, latency, and dependency
    health.
-   Load-test and failure-test reporting.

------------------------------------------------------------------------

## Architecture

``` text
                          ┌───────────────────────┐
                          │      API Consumer     │
                          │  Application / Client │
                          └───────────┬───────────┘
                                      │ HTTPS + API key
                                      ▼
                          ┌───────────────────────┐
                          │       MeterGate       │
                          │   Fastify Gateway     │
                          │                       │
                          │ Authentication        │
                          │ Tenant / Plan Context │
                          │ Rate Limits / Quotas  │
                          │ Request IDs / Logging │
                          │ Reverse Proxy         │
                          │ Usage Counters        │
                          └──────┬────────┬───────┘
                                 │        │
                      ┌──────────┘        └───────────┐
                      ▼                               ▼
             ┌────────────────┐              ┌────────────────┐
             │     Redis      │              │   PostgreSQL   │
             │ Cache / Limits │              │ Durable State  │
             │ Counters / Jobs│              │ Tenants / APIs │
             └────────┬───────┘              │ Keys / Plans   │
                      │                      │ Usage / Billing│
                      ▼                      └────────┬───────┘
             ┌────────────────┐                       │
             │  Usage Worker  │───────────────────────┘
             │ Async Processing│
             └────────┬───────┘
                      │
                      ▼
             ┌────────────────┐        ┌─────────────────────┐
             │ Stripe Billing │        │   Upstream APIs     │
             │ Webhooks       │        │ Provider Services   │
             └────────────────┘        └─────────────────────┘

             Prometheus ──collects──> MeterGate / dependencies
                  │
                  ▼
               Grafana
```

The diagram represents the intended logical architecture. The exact
process boundaries and deployment topology depend on the implemented
release.

### Architectural principles

1.  **Keep the gateway focused.** Request routing and policy enforcement
    should not be burdened with slow billing operations.
2.  **Use the right storage for each workload.** Redis handles
    low-latency shared state; PostgreSQL holds durable relational
    records.
3.  **Make shared operations concurrency-safe.** Distributed rate limits
    and usage processing must account for simultaneous requests and
    workers.
4.  **Treat billing records as financially sensitive.** Usage
    aggregation, retries, webhooks, and reconciliation require explicit
    correctness controls.
5.  **Prefer a simple initial deployment.** Add orchestration or
    distributed infrastructure only when requirements justify it.

## Technology Stack

  -----------------------------------------------------------------------
  Area                    Technology              Purpose
  ----------------------- ----------------------- -----------------------
  Gateway                 Node.js, TypeScript,    HTTP routing and proxy
                          Fastify                 request handling

  Database                PostgreSQL, Prisma      Durable relational data
                                                  and migrations

  Shared state            Redis, Redis Lua        Caching, atomic
                                                  counters, token buckets

  Asynchronous processing Node.js worker; Redis   Usage aggregation and
                          Streams or a queue      background jobs
                          where implemented       

  Billing                 Stripe API and webhooks Subscription and
                                                  metered billing
                                                  integration

  Dashboard               React, TypeScript,      Customer and
                          Tailwind CSS            administrator interface

  Metrics                 Prometheus, Grafana     Collection and
                                                  visualization of
                                                  operational metrics

  Testing                 Vitest, Supertest, k6,  Unit, integration,
                          Autocannon              load, and performance
                                                  testing

  Deployment              Docker, Docker Compose, Repeatable packaging
                          Nginx, Linux            and reverse-proxy
                                                  deployment

  Version control / CI    Git, GitHub Actions     Source control and
                          where configured        automated checks
  -----------------------------------------------------------------------

Not every optional technology is required in every deployment. The
actual dependency list should match the source code and lockfiles.

------------------------------------------------------------------------

## Request Lifecycle

A typical API request passes through the following stages:

1.  **Receive request:** MeterGate accepts an incoming HTTP request and
    creates or validates a request ID.
2.  **Normalize and validate:** The gateway validates required request
    properties and applies request-size and timeout policies.
3.  **Authenticate:** The bearer API key is validated against cached or
    durable credential data.
4.  **Resolve tenant and API:** The gateway establishes the trusted
    tenant, API, and plan context.
5.  **Apply policies:** Rate limits, monthly quotas, and other
    configured access rules are checked.
6.  **Prepare upstream request:** Untrusted identity headers are
    removed; trusted gateway metadata is added.
7.  **Proxy request:** The request is forwarded to the configured
    upstream service.
8.  **Handle response:** MeterGate relays the upstream status and
    response while applying safe response handling.
9.  **Record usage:** Counters and event data are updated using the
    configured metering path.
10. **Report and bill:** Background processing aggregates usage for
    analytics and, where enabled, billing.

Requests that fail authentication or policy checks should be rejected
before they reach the upstream service.

## Security Design

Security is a core system requirement because MeterGate sits in front of
other services and processes credentials and usage data.

### Credential protection

-   Never persist complete API-key secrets in plaintext.
-   Display a secret only at creation time if that is the chosen key
    lifecycle.
-   Store only a cryptographic hash and non-secret metadata.
-   Use environment variables or a dedicated secret manager for
    deployment secrets.
-   Rotate credentials when exposure is suspected.

### Header trust boundaries

Incoming clients must not be allowed to select their own trusted tenant
identity. Remove or overwrite identity headers such as:

-   `X-Tenant-ID`
-   `X-User-ID`
-   `X-Role`

The gateway must derive trusted identity from the authenticated
credential and then inject its own internal metadata.

### Tenant isolation

Every tenant-scoped API operation must enforce ownership checks. A
customer must not be able to read or modify another tenant's API keys,
APIs, usage records, plans, or billing information by changing an
identifier in a request.

### Upstream URL validation and SSRF prevention

Configurable upstream URLs introduce server-side request forgery (SSRF)
risk. Upstream registration must validate schemes and destinations,
block loopback, link-local, private, and other prohibited address ranges
as appropriate to the deployment, and defend against DNS rebinding and
redirects to disallowed destinations. Apply network-level egress
controls as an additional protection.

### Additional controls

-   Use TLS for public or otherwise untrusted network traffic.
-   Restrict and authenticate Redis and PostgreSQL.
-   Validate input and use parameterized database operations or a
    correctly configured ORM.
-   Verify Stripe webhook signatures.
-   Enforce webhook idempotency.
-   Apply request-size limits, timeouts, and abuse controls.
-   Avoid logging API keys, authorization headers, passwords, payment
    secrets, or other sensitive payloads.
-   Maintain audit records for security-sensitive administrative
    actions.
-   Review dependencies and keep them patched.

A completed security review should record the tests performed, findings,
severity, remediation, and any remaining risks. Security claims should
be backed by test evidence.

## Reliability and Failure Handling

  -----------------------------------------------------------------------
  Failure scenario                    Expected behavior
  ----------------------------------- -----------------------------------
  Invalid or revoked API key          Reject the request without
                                      forwarding it

  Rate limit exceeded                 Return a documented rate-limit
                                      response

  Monthly quota exceeded              Return a documented quota response

  Upstream unavailable                Return a controlled `502` or `503`
                                      response

  Upstream too slow                   Apply connection/read timeouts and
                                      return a controlled error

  Redis unavailable                   Follow a documented
                                      fail-open/fail-closed policy; do
                                      not silently bypass critical
                                      controls

  PostgreSQL unavailable              Use valid cached data only where
                                      safe; avoid pretending uncached
                                      data is verified

  Worker restarts                     Resume processing without silently
                                      losing or duplicating billable
                                      usage

  Duplicate Stripe webhook            Recognize previously processed
                                      event IDs and avoid duplicate side
                                      effects

  Stripe temporarily unavailable      Retry or queue billing work without
                                      blocking ordinary proxy traffic
                                      unnecessarily

  Gateway instance fails              Allow another healthy stateless
                                      instance to serve traffic when the
                                      deployment supports it
  -----------------------------------------------------------------------

### Usage correctness

Usage metering requires explicit guarantees. A worker may crash after
reading a counter but before committing it to the database. A safe
design uses durable events or an atomic claim-and-acknowledgement
workflow, database transactions, idempotent persistence, retries, and
periodic reconciliation. Do not assume that Redis counters plus a timer
alone guarantee exactly-once billing.

The chosen design should document whether processing is at-most-once,
at-least-once, or effectively-once through deduplication and
reconciliation.

------------------------------------------------------------------------

## Observability

### Health endpoints

-   `GET /health` --- basic process health.
-   `GET /ready` --- whether the instance is ready to serve traffic,
    including the dependency checks required by the deployment.
-   `GET /metrics` --- Prometheus metrics, when metrics support is
    enabled.

Health and readiness endpoints should have clearly defined semantics. A
liveness check should not necessarily fail merely because an optional
external service is unavailable.

### Suggested metrics

  -----------------------------------------------------------------------
  Metric                              Purpose
  ----------------------------------- -----------------------------------
  `requests_total`                    Total requests, with
                                      controlled-cardinality labels

  `requests_failed_total`             Failed gateway or upstream requests

  `rate_limited_total`                Requests rejected by rate limiting

  `quota_exceeded_total`              Requests rejected by quota
                                      enforcement

  `request_duration_seconds`          Gateway request-duration
                                      distribution

  `upstream_errors_total`             Upstream error count

  `redis_errors_total`                Redis operation failures
  -----------------------------------------------------------------------

Use bounded labels such as route template, status class, and dependency
name. Avoid labels containing raw URLs, request IDs, API keys, tenant
secrets, or arbitrary user input because they can expose sensitive
information and create unbounded metric cardinality.

### Structured logging

Example log event:

``` json
{
  "request_id": "req_example",
  "tenant_id": "tenant_example",
  "route": "/api/weather",
  "status": 200,
  "latency_ms": 23
}
```

This is an illustrative schema, not a measured production record. Logs
should use consistent field names and omit secrets.

------------------------------------------------------------------------

## Data Model

The relational data model is designed around tenants, credentials, APIs,
plans, usage, and billing.

  Entity             Responsibility
  ------------------ -----------------------------------------------------
  `users`            Dashboard identities and account access
  `tenants`          Customer or organization accounts
  `api_keys`         Hashed API credentials and lifecycle metadata
  `plans`            Rate limits, quotas, and plan configuration
  `subscriptions`    Tenant subscription and billing relationship
  `apis`             Registered API products
  `upstreams`        Backend service targets and configuration
  `usage`            Aggregated usage by tenant, API, and billing period
  `usage_events`     Detailed or queued metering events, where retained
  `webhook_events`   Processed webhook IDs for idempotency
  `audit_logs`       Security and administrative activity

Additional tables may be required for API routes, plan-specific
rate-limit rules, invoices, key rotations, reconciliation jobs, and team
membership.

### Data integrity principles

-   Use primary keys, foreign keys, and appropriate uniqueness
    constraints.
-   Index common lookup paths, such as tenant ID, key prefix/hash, API
    ID, and billing period.
-   Use transactions for operations that must succeed or fail together.
-   Enforce tenant ownership at the service or data-access layer.
-   Define retention policies for detailed usage events and operational
    logs.
-   Keep billing-relevant records traceable and reconcilable.

The final schema and migrations should be treated as the authoritative
implementation rather than this conceptual entity list.

------------------------------------------------------------------------

## API Overview

The endpoints below describe a suggested public API surface. Exact
paths, request schemas, response codes, and authentication rules must
match the implemented routes and API specification.

### Gateway endpoints

  -----------------------------------------------------------------------
  Method                  Endpoint                Purpose
  ----------------------- ----------------------- -----------------------
  `GET`                   `/health`               Process health

  `GET`                   `/ready`                Readiness status

  `GET`                   `/metrics`              Operational metrics

  `ANY`                   Configured gateway      Forward an allowed
                          route                   request to its upstream
  -----------------------------------------------------------------------

### Management API

  Method     Example endpoint     Purpose
  ---------- -------------------- --------------------------------------
  `POST`     `/tenants`           Create a tenant
  `GET`      `/tenants`           List tenants available to the caller
  `GET`      `/tenants/:id`       Retrieve a tenant
  `PATCH`    `/tenants/:id`       Update permitted tenant properties
  `POST`     `/api-keys`          Create an API key
  `GET`      `/api-keys`          List key metadata
  `DELETE`   `/api-keys/:id`      Revoke or deactivate a key
  `POST`     `/apis`              Register an API
  `GET`      `/apis`              List registered APIs
  `POST`     `/plans`             Create or configure a plan
  `GET`      `/usage`             Retrieve authorized usage summaries
  `POST`     `/webhooks/stripe`   Receive Stripe webhook events

These are illustrative route names based on the project specification.
Do not treat them as verified endpoints until confirmed against the
running application.

### API conventions

-   Use consistent JSON request and response formats.
-   Validate all incoming data.
-   Return appropriate HTTP status codes.
-   Use a stable error format with a request ID.
-   Paginate potentially large list and usage responses.
-   Document authentication requirements and tenant access rules.
-   Apply idempotency to operations that may be retried and can create
    financial or other important side effects.

Example gateway error:

``` json
{
  "error": "bad_gateway",
  "message": "The upstream service could not be reached.",
  "request_id": "req_example"
}
```

------------------------------------------------------------------------

## Developer Dashboard and Portal

The dashboard is the customer-facing management layer for the gateway.

### Dashboard

-   Request volume and trends.
-   Error rates and latency summaries.
-   Usage against monthly quotas.
-   Active API and upstream status.

### APIs

-   Register API products and upstream targets.
-   Configure routes and allowed methods where supported.
-   Inspect upstream health and configuration status.

### API keys

-   Create keys for development or production use.
-   View safe metadata such as name, prefix, creation date, and status.
-   Revoke and rotate keys.
-   Set expiry and IP restrictions where supported.

### Plans and usage

-   Define plan-level request limits and monthly quotas.
-   View consumption by tenant, API, endpoint, and billing period.
-   Identify customers approaching their quotas.

### Billing

-   Display subscription status and billing records.
-   Show invoices and payment status returned by the billing provider.
-   Explain included usage and additional usage where supported.

### Developer portal

A developer portal can provide API documentation, authentication
instructions, API-key onboarding, and an interactive "Try it"
experience. OpenAPI import and generated documentation are useful
extensions when implemented.

------------------------------------------------------------------------

## Project Structure

The following is a recommended modular structure for the complete
platform. Keep the repository aligned with the actual codebase and avoid
creating empty directories solely to match this diagram.

``` text
metergate/
├── apps/
│   ├── gateway/             # Fastify gateway and reverse proxy
│   ├── api/                 # Tenant and management API
│   ├── worker/              # Usage and background processing
│   └── dashboard/           # React + TypeScript UI
├── packages/
│   ├── database/            # Prisma schema, client, migrations
│   ├── redis/               # Redis client and shared operations
│   ├── auth/                # API-key validation and tenant context
│   ├── rate-limiter/        # Token bucket and policy enforcement
│   ├── metering/             # Usage events and aggregation
│   ├── billing/              # Billing provider integration
│   ├── proxy/                # Upstream forwarding and header policy
│   └── shared/               # Shared types, schemas, and utilities
├── infrastructure/
│   ├── docker/
│   ├── nginx/
│   ├── prometheus/
│   └── grafana/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── load/
│   └── failure/
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── security.md
│   └── billing.md
├── docker-compose.yml
├── package.json
├── package-lock.json
├── .env.example
└── README.md
```

The initial repository may use a smaller structure. Refactor into
workspaces or separate applications only when it improves
maintainability.

------------------------------------------------------------------------

## Prerequisites

For local development, install:

-   Node.js 20 or a supported newer LTS version.
-   npm.
-   Git.

For the complete platform, also provide the services used by the
configured release:

-   PostgreSQL.
-   Redis.
-   Docker and Docker Compose for containerized development or
    deployment.
-   Stripe test credentials for billing integration tests.
-   Prometheus and Grafana if the metrics stack is enabled.

The current simple gateway phase requires Node.js and npm; database,
Redis, billing, dashboard, and observability prerequisites apply only
when those components are included.

## Configuration

Use environment variables for deployment-specific settings. Never commit
real secrets.

Example `.env.example`:

``` dotenv
NODE_ENV=development
PORT=3000
HOST=127.0.0.1

# Local mock upstream
UPSTREAM_URL=http://127.0.0.1:4000
UPSTREAM_TIMEOUT_MS=5000

# Configure these only when the corresponding modules are implemented.
DATABASE_URL=postgresql://metergate:change-me@127.0.0.1:5432/metergate
REDIS_URL=redis://127.0.0.1:6379

# Billing integration: use test-mode credentials during development.
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Observability
METRICS_ENABLED=false
LOG_LEVEL=info
```

Configuration names vary by implementation; verify them against the
application code before use. Replace example credentials with local
development values and use a secret manager or protected environment
configuration in deployed environments.

### Network binding

Binding to `127.0.0.1` limits the service to local connections. For
container or LAN deployment, the bind address may need to be `0.0.0.0`,
with access controlled through container networking, host firewalls, and
the deployment reverse proxy. Do not expose an unauthenticated
management interface publicly.

------------------------------------------------------------------------

## Local Development

### 1. Clone the repository

``` bash
git clone <YOUR_REPOSITORY_URL>
cd metergate
```

Replace `<YOUR_REPOSITORY_URL>` with the repository URL.

### 2. Install dependencies

``` bash
npm install
```

### 3. Start the mock upstream

In terminal one:

``` bash
npm run mock
```

The current Phase 1 mock upstream is expected to listen on port `4000`.

### 4. Start MeterGate

In terminal two:

``` bash
npm run dev
```

The current Phase 1 gateway is expected to listen on port `3000`.

### 5. Test the gateway

Check health:

``` bash
curl -i http://127.0.0.1:3000/health
```

Send a request through the gateway:

``` bash
curl -i http://127.0.0.1:3000/hello
```

The mock upstream should respond through MeterGate when both processes
are running and the upstream configuration is correct.

### Troubleshooting

**Gateway returns `502 Bad Gateway`**

-   Confirm the mock upstream is running.
-   Check that it is listening on port `4000`.
-   Confirm `UPSTREAM_URL` points to `http://127.0.0.1:4000` for a local
    non-container setup.
-   Inspect the gateway logs for timeout or connection errors.

**Connection refused on `localhost`**

On some systems, `localhost` can resolve to IPv6 (`::1`) while a service
listens only on IPv4. Try `127.0.0.1`, and make sure the bind address
and upstream URL are compatible.

**Port already in use**

Identify the process occupying the port or change the relevant
configuration before restarting the service.

------------------------------------------------------------------------

## Docker Deployment

Docker and Docker Compose provide a repeatable way to run the gateway
and its supporting services. The exact service names, ports, health
checks, and environment variables depend on the repository's
`docker-compose.yml`.

A typical deployment may include:

-   Gateway and management API.
-   PostgreSQL.
-   Redis.
-   Usage worker.
-   Dashboard.
-   Nginx.
-   Prometheus and Grafana, if enabled.

Example commands, when the repository contains a compatible Compose
file:

``` bash
docker compose config
docker compose up --build -d
docker compose ps
docker compose logs -f
```

Stop the stack:

``` bash
docker compose down
```

Do not remove persistent volumes unless you intentionally want to delete
local database or service data. Before production deployment, configure
durable storage, backups, secret injection, resource limits, TLS,
firewall rules, health checks, and a documented recovery process.

### Production deployment checklist

-   [ ] Use HTTPS at the trusted network boundary.
-   [ ] Restrict management endpoints to authorized users.
-   [ ] Store secrets outside source control.
-   [ ] Configure Redis and PostgreSQL authentication and network
    restrictions.
-   [ ] Configure database backups and test restoration.
-   [ ] Apply request-size and timeout limits.
-   [ ] Validate upstream destinations and prevent SSRF.
-   [ ] Configure log retention and monitoring alerts.
-   [ ] Run security, integration, and load tests.
-   [ ] Document rollback and incident-response procedures.

------------------------------------------------------------------------

## Testing and Quality Assurance

A complete test strategy should cover more than whether the proxy can
forward a request.

### Unit tests

Test isolated components such as:

-   API-key hashing and validation.
-   Request and response header filtering.
-   Rate-limit calculations.
-   Quota threshold logic.
-   Usage aggregation.
-   Webhook signature and idempotency logic.
-   Error mapping and request-ID generation.

### Integration tests

Verify interactions with real or test instances of PostgreSQL, Redis,
the upstream mock, and the billing test environment.

### Security tests

Include:

-   Missing, malformed, invalid, expired, and revoked API keys.
-   Attempts to spoof tenant identity through request headers.
-   Cross-tenant access attempts.
-   Rate-limit and quota bypass attempts.
-   SSRF attempts using prohibited destinations and redirect chains.
-   Oversized requests and slow upstream responses.
-   Invalid and replayed webhook events.
-   Sensitive-data leakage in logs.
-   Dependency and configuration checks.

Only test systems you own or are authorized to assess.

### Failure-mode tests

Intentionally test dependency outages and restarts:

-   Redis becomes unavailable.
-   PostgreSQL becomes unavailable.
-   Upstream stops responding.
-   A worker restarts during usage processing.
-   Stripe delivery is delayed or repeated.
-   A gateway instance exits during traffic.

Document expected behavior, observed behavior, data loss or duplication,
and remediation.

------------------------------------------------------------------------

## Performance Reporting

MeterGate should be benchmarked under repeatable conditions using tools
such as k6 or Autocannon. Test the gateway with a simple upstream and
with the actual enabled policy checks, then compare the results with
direct upstream requests.

Record at least:

-   Hardware and operating system.
-   Node.js version and build configuration.
-   Deployment topology and dependency versions.
-   Concurrency and request rate.
-   Request count and duration.
-   Throughput in requests per second.
-   p50, p95, and p99 latency.
-   Error rate and status-code distribution.
-   CPU and memory usage.
-   Redis and PostgreSQL latency where relevant.

### Benchmark results

Populate this table only after running and recording the tests.

  ------------------------------------------------------------------------------------
  Scenario           Requests   Throughput        p50        p95        p99 Error rate
  ---------------- ---------- ------------ ---------- ---------- ---------- ----------
  Direct upstream         TBD          TBD        TBD        TBD        TBD        TBD
  baseline                                                                  

  Gateway, proxy          TBD          TBD        TBD        TBD        TBD        TBD
  only                                                                      

  Gateway with            TBD          TBD        TBD        TBD        TBD        TBD
  authentication                                                            

  Gateway with            TBD          TBD        TBD        TBD        TBD        TBD
  rate limiting                                                             
  and metering                                                              
  ------------------------------------------------------------------------------------

Do not claim a performance target as an achieved result unless the
measurements support it. A target such as 5--10 ms p99 of gateway
overhead is a goal to evaluate, not a guaranteed property.

------------------------------------------------------------------------

## Operational Guidance

### API-key lifecycle

Create keys with sufficient entropy, store only the chosen cryptographic
hash representation, show the raw key only when issued if applicable,
and support revocation. Cache invalidation must ensure revoked keys are
not accepted beyond the documented revocation window.

### Rate-limit policy

Define the policy for Redis failure explicitly. Failing open may
preserve availability but allow abuse; failing closed protects upstream
resources but can deny legitimate traffic. Select behavior based on the
endpoint's risk and document it.

### Usage reconciliation

Compare Redis or queue-derived usage with durable aggregates and billing
records. Retain enough event identifiers or checkpoints to investigate
discrepancies. Establish an operational process for correcting usage
without creating duplicate charges.

### Database operations

Use migrations, backups, connection-pool limits, and restore tests.
Review indexes against actual query patterns and avoid unbounded usage
queries.

### Incident response

Logs and metrics should make it possible to trace a request by request
ID without exposing secrets. Document how to revoke a key, disable an
upstream, pause billing ingestion, restore data, and rotate credentials
during an incident.

------------------------------------------------------------------------

## Known Design Considerations

MeterGate is infrastructure software and requires careful operational
decisions. Important considerations include:

-   **Billing accuracy:** request counts and persisted usage must remain
    reconcilable through retries and crashes.
-   **Cache invalidation:** key revocation and policy changes must reach
    all gateway instances within a documented period.
-   **SSRF protection:** upstream configuration must not allow access to
    internal or prohibited network resources.
-   **Metric cardinality:** high-cardinality labels can overload
    monitoring systems.
-   **Timeout budgets:** gateway, upstream, worker, and client timeouts
    should work together.
-   **Abuse and resource limits:** protect against oversized bodies,
    slow clients, excessive concurrency, and expensive upstream calls.
-   **Privacy and retention:** define what usage data is stored and for
    how long.
-   **Operational simplicity:** do not introduce Kubernetes, Kafka,
    multi-region deployment, or additional microservices until there is
    a concrete need.

## Roadmap Extensions

The platform can be extended with:

-   OpenAPI import and generated documentation.
-   Multiple upstreams, health checks, retries, circuit breakers, and
    load balancing.
-   Team roles and organization-level access management.
-   Key IP restrictions and advanced abuse detection.
-   Custom domains and developer branding.
-   More detailed analytics and exportable usage reports.
-   Additional billing providers and payment methods.
-   Horizontal gateway scaling and deployment automation.
-   A public developer portal and API marketplace.

These are extension opportunities, not statements that every feature is
present in the current repository.

------------------------------------------------------------------------

## Contributing

Contributions should preserve the project's security and reliability
goals.

1.  Create a branch for the change.
2.  Keep modules small and typed.
3.  Add or update tests for changed behavior.
4.  Run the relevant checks before opening a pull request.
5.  Document new configuration variables and API behavior.
6.  Never commit secrets, production data, or customer credentials.
7.  Explain migrations, operational impacts, and security implications
    in the pull request.

Use the repository's configured scripts as the source of truth for
linting, type checking, and test commands.

## License

Choose and add a license before distributing the project publicly. Until
a license is included in the repository, do not assume others have
permission to reuse, modify, or redistribute the code.

## Acknowledgements

MeterGate is built around established ideas in HTTP proxying, API
security, distributed rate limiting, usage metering, and observability.
Its implementation should document relevant dependencies and credit
external projects according to their licenses.

------------------------------------------------------------------------

## Final Note

MeterGate's long-term goal is to make API monetization straightforward:
a developer registers an API, defines access policies and plans, issues
credentials, observes usage, and connects measured consumption to
billing.

A strong release is not defined only by the number of features. It is
defined by evidence that authentication is secure, traffic controls are
concurrency-safe, usage is reconcilable, failures are handled
predictably, and performance claims are reproducible.
