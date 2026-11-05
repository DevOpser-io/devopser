# Self-Evolving Software Template — Agent Guide

This file is written for **AI coding agents** (Claude Code, Cursor, Aider, Copilot Workspace, etc.) configuring or extending this template on behalf of a human.

The core idea: this repo ships a **running full-stack SaaS starter kit** — Express.js, Postgres, Redis, pluggable AI chat (Bedrock / OpenAI / Anthropic), auth (local + Google + magic link + MFA), an admin panel, an example website builder, and a mobile shell. It's **not a vertical product** — it's a template you configure for whatever SaaS the human is building (CRM, help desk, analytics dashboard, AI chatbot platform, project management tool, e-commerce, etc.). The website builder is one example feature; keep it, extend it, or replace it.

**Three things are deliberately left blank** for you to fill in once the human tells you what they're building and where:

1. **Their actual product.** The website builder UI at `/` is a starting point, not the destination. Ask what they're building and reshape the routes, models, and UI accordingly.
2. **The deployment target.** No bundled CI, no cloud-specific IAC. Pick a target (Lightsail / Cloud Run / Fly / ECS / K8s / VPS / …), generate the IAC, and wire it into `backend/routes/sites.js → triggerDeployment()`.
3. **Billing and metering.** No Stripe / Paddle / usage tracking. Add whichever fits.

Treat this file as your playbook. When asked to "deploy", "publish", "set up hosting", "add Cloud Run / Lightsail / ECS / Fly / K8s / a VPS / …", "turn this into a CRM / help desk / analytics tool / …", or "add Stripe billing", start here.

---

## Quick setup (for AI agents)

When the human says **"set this up for me"**, **"get it running"**, **"install this"**, or anything similar, follow this exact sequence. Do not skip the credential question — the chat UI will not work without one of the three LLM providers configured.

### 1. Bootstrap

```bash
./scripts/setup.sh
```

This is idempotent. It checks Node 20+ / Docker, creates `.env` from `.env.example`, starts Postgres + Redis via `docker compose`, installs all npm dependencies, runs migrations, and seeds the default admin user (`admin@example.com` / `adminpass`).

If it fails on a prerequisite, relay the error to the user verbatim — it's designed to give them the exact command to fix it (e.g. `brew install node@20`, `open -a Docker`).

If it fails on port conflicts (`bind: address already in use`), re-run with overrides:

```bash
POSTGRES_PORT=5433 REDIS_PORT=6380 ./scripts/setup.sh
```

and remember to mirror those ports in `.env` (`POSTGRES_PORT`, `REDIS_URL`) for the `npm run dev` path.

### 2. Ask the user for LLM credentials

The server will boot without them (the providers are lazy-initialized), but the chat UI will throw on first use. Ask **once**:

> Which LLM provider do you want to use?
> - **OpenAI** — simplest, just needs `OPENAI_API_KEY` (get one at https://platform.openai.com/api-keys)
> - **Anthropic (direct Claude API)** — needs `ANTHROPIC_API_KEY` (https://console.anthropic.com/settings/keys)
> - **AWS Bedrock** — needs AWS creds with `bedrock:InvokeModel` permission in a Bedrock-enabled region (us-east-1, us-west-2, etc.)

Update `.env` accordingly:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

or

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

or (Bedrock)

```env
LLM_PROVIDER=bedrock
REGION=us-east-1
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

**Bedrock + MFA-protected IAM identity** (very common at real companies): the default profile's long-term keys will hit an explicit-deny from a `requireMFA`-style policy. Have the user export an MFA session into the shell **before** starting the server:

```bash
eval "$(AWS_PROFILE=<their-mfa-profile> aws configure export-credentials --format env)"
```

These are temporary credentials — they expire (typically 1–12h). When the user reports "chat stopped working with `security token invalid`", re-run the export and restart the server. Do NOT write these keys into `.env` — they'd go stale.

**Known gotcha:** Node AWS SDK v3 cannot always read profiles defined in `~/.aws/config` (as opposed to `~/.aws/credentials`). Prefer the `aws configure export-credentials` path over `AWS_PROFILE=...`.

### 3. Start the app

Two paths — ask the user which they want, or pick `npm run dev` by default for fastest iteration:

**Hot-reload dev server (fastest feedback loop):**
```bash
npm run dev
```

**Fully containerized (closer to prod):**
```bash
docker compose --profile app up -d --build
docker logs -f sest-app   # to watch startup
```

The containerized path runs Sequelize migrations automatically on container start. Either path puts the app on **http://localhost:8000**. Sign in with `admin@example.com` / `adminpass` (change immediately).

### 4. Verify

Before reporting success, actually hit the server:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:8000/auth/login
# expect: 200
```

Do not report "setup complete" until the curl returns 200 **and** you've checked the server logs for a `Server running on http://localhost:8000` line (plus, if using Bedrock, a `Current AWS Identity:` line showing the expected account).

### 5. What's deliberately left for later

After the app is running, the human will usually want one or more of:

- **Their actual product** — ask what they're building, then reshape routes/models/UI (see the extension points section below)
- **A deployment target** — pick one and wire it into `backend/routes/sites.js → triggerDeployment()` (see the deployment section). Working single-tenant reference implementations already exist for **AWS Elastic Beanstalk** at [`deploy/eb/`](deploy/eb/README.md) and **AWS App Runner** at [`deploy/apprunner/`](deploy/apprunner/README.md) — if the human asks for either, read that module's README first and extend from there; do NOT write new CloudFormation from scratch.
- **Billing** — Stripe / Paddle / usage metering
- **Real email** — fill in `MAIL_*` in `.env` with Gmail app password or SES config

---

## Repo map

```
/
├── Dockerfile                   # Minimal node:23-slim image, runs on :8000
├── README.md                    # Human onboarding (prereqs, local dev, features)
├── SELF_HOSTING.md              # Human self-hosting guide (DB, Redis, Bedrock, Secrets Manager)
├── AGENTS.md                    # ← you are here
├── .env.example                 # All configurable env vars, grouped by subsystem
│
├── frontend/                    # Vanilla JS + Webpack, built to backend/public/static/dist
│
├── backend/
│   ├── server.js                # Express entry point. Bootstrap hooks live here.
│   ├── config/                  # Env-driven config, NODE_ENV-gated for prod/dev
│   ├── models/                  # Sequelize models (User, Site, Lead, ApiKey, Deployment, …)
│   ├── migrations/              # Sequelize migrations — always forward-only
│   ├── routes/                  # Express routers
│   │   ├── auth.js              #  login, magic-link, MFA, Google OAuth
│   │   ├── chat.js              #  /api/chat/* SSE streaming
│   │   ├── sites.js             #  website builder CRUD + publish stub
│   │   ├── api.js               #  JSON API key-protected endpoints
│   │   └── index.js             #  landing, account, admin
│   ├── controllers/
│   │   └── chatController.js    # Streams LLM output to clients
│   └── services/
│       ├── llm/                 # Pluggable LLM providers (bedrock|openai|anthropic)
│       ├── bedrockService.js    # AWS Bedrock client (singleton, cross-account capable)
│       ├── emailService.js      # SES or Gmail SMTP, gated by NODE_ENV
│       ├── redisService.js      # Session/chat history storage
│       ├── secretsManager.js    # AWS Secrets Manager resolver (production only)
│       ├── s3Service.js         # Site-image uploads
│       ├── templateService.js   # Website template schemas
│       └── websiteAgentService.js  # AI-driven site config editor
│
└── mobile-*.html                # Capacitor webview screens (Android/iOS shell)
```

---

## Core extension points

The template is designed so you can swap subsystems without touching application code. Before writing anything new, check if the problem already has a plug-in point:

### 1. LLM provider — `backend/services/llm/`

Supported: `bedrock`, `openai`, `anthropic`. Selected by `LLM_PROVIDER` env var.

To add a new provider (e.g. Mistral, Cohere, local vLLM, Together.ai):

1. Copy `openaiProvider.js` as a starting point — it's the simplest.
2. Implement `create()` returning an object with two methods:
   - `generateResponse(messages): Promise<string>` — non-streaming, returns the full text.
   - `streamResponse(messages): AsyncIterable<string>` — yields plain text deltas. **Normalize** any provider-specific chunk format into text-only deltas; `chatController.js` consumes the iterable blindly.
3. Register the provider name in `backend/services/llm/index.js` → the `switch` block.
4. Add a new block to `.env.example` and `README.md` documenting the required env vars.

You do **not** need to touch `chatController` or `websiteAgentService` — they call through the facade.

### 2. Email transport — `backend/services/emailService.js`

Two modes, gated by `NODE_ENV`:

- `development` → reads `MAIL_SERVER / MAIL_PORT / MAIL_USERNAME / MAIL_PASSWORD` directly from env. Works with Gmail app passwords or any SMTP provider (Postmark, Mailgun, Resend, SendGrid, Postfix, …).
- `production` → reads the same vars as **secret names**, resolves them through AWS Secrets Manager.

`USE_SES=true` uses AWS SES in both modes instead. If you add a new transport (Postmark API, Resend API, etc.), mirror this NODE_ENV gate so self-hosted and managed-hosting deployments use the same code.

### 3. Authentication method — `backend/routes/auth.js` + Passport strategies

Built-in: local (email/password + bcrypt), Google OAuth, magic link (SMTP), TOTP MFA, API keys.

To add a new provider (GitHub, SAML, Auth0, WorkOS, Clerk, …):

1. Install the matching Passport strategy or SDK.
2. Wire it up in `backend/config/passport.js`.
3. Add routes in `backend/routes/auth.js`.
4. Mirror the `triggerAWSAccountProvisioning()` stub hook after successful login if your deployment target needs per-user bootstrap — this is the right place for tenant provisioning.

### 4. Deployment target — `backend/routes/sites.js → triggerDeployment()`

This is the **main blank-slate extension point** and where you'll spend the most time. See the next section.

---

## The two chat surfaces (understand before editing)

The template ships **two distinct chat UI paths** that look similar but serve very different purposes. Figure out which one you want to touch before you start editing — they live in different files and have different auth, persistence, and backend contracts.

### `/` — Landing page, stateless preview

| | |
|---|---|
| **Route** | `backend/routes/index.js:13` |
| **Template** | `backend/templates/landing-builder.ejs` |
| **Frontend JS** | `backend/public/static/js/landing-builder.js` |
| **Auth** | None — public, anonymous visitors can use it |
| **Persistence** | None — nothing is stored server-side |
| **Backend call** | `POST /api/preview/generate` (anonymous) |
| **Shape** | Single-turn. Visitor types a prompt, backend calls the LLM once, renders the result inline |

Purpose: the **"try before you sign up"** hook. A visitor lands on `/`, types something into the chat input, gets a single LLM-generated preview, and is prompted to sign up if they want to save/publish it. On sign-up, the original prompt is converted into a real `Site` row via `POST /api/sites` and they're redirected into `/sites/:id/builder` (the authenticated builder UI).

There's no `conversationId`, no Redis entry, no message history — every prompt is a fresh one-shot call. Intentionally cheap so anonymous traffic doesn't inflate your Redis bill or force you to deal with abuse on a persisted data store.

### `/chat` — Full conversational app, stateful

| | |
|---|---|
| **Route** | `backend/routes/chat.js:24` |
| **Template** | `backend/templates/chat.ejs` |
| **Controller** | `backend/controllers/chatController.js` |
| **Auth** | `ensureFullAuth` — must be logged in **and** MFA-verified |
| **Persistence** | Full thread history in Redis, keyed by `conversationId` (see `backend/services/redisService.js`) |
| **Backend call path** | `POST /api/chat/message` → `POST/GET /api/chat/stream` (SSE) |
| **History endpoints** | `GET /conversation_history`, `GET /get_conversation/:id`, `POST /reset` |
| **Shape** | Multi-turn. Every request pulls the whole thread for the active `conversationId`, appends the new message, sends the full history to the LLM, streams the response back, writes the updated history back |

Purpose: the **"real product"** chat — a proper conversational AI app with memory. Every turn rebuilds the full context from Redis so the model can reason across the whole thread. Supports listing past conversations, loading a specific one, and resetting.

This is what you ship to paying users. It's the surface where you plug in per-user tools, RAG, function calling, custom system prompts, conversation branching, etc.

### Which one to modify

- **Building a landing page / lead funnel / "try before you buy" flow** → edit `/` and `landing-builder.js`. Cheap. No DB schema, no auth concerns, no Redis bookkeeping. If you want the single-turn call to go through the LLM facade instead of `/api/preview/generate`, route it through `llm.generateResponse()` directly.
- **Building a user-facing chat product** (support desk, coding assistant, tutor, therapist, analyst, whatever) → edit `/chat` and `chatController.js`. Replace the system prompt, plug in your tools, restyle the `chat.ejs` template. The streaming pipeline and conversation storage already work; don't rebuild them.
- **Building a SaaS that isn't chat-centric at all** (CRM, project tracker, analytics dashboard, …) → you can delete both chat surfaces and `backend/services/llm/` entirely. The auth, admin, email, database, mobile-shell, and session infrastructure all stand on their own — the app is still a valid authenticated Express starter without any LLM code.

### Common mistake

Don't edit `landing-builder.js` thinking you're improving the main chat app — the main chat app lives in `chat.ejs` and `chatController.js`, and they don't share code with the landing page. If you change the system prompt on `/`, it only affects anonymous preview calls.

---

## Public vs authenticated routes (important — read before adding endpoints)

The template uses a **default-deny** auth model: if a new route you add isn't explicitly listed as public, any unauthenticated request to it will be redirected away from it before your handler ever runs. People bolt on a new endpoint, curl it, get a redirect, and spend twenty minutes debugging the wrong thing. Don't be that.

### How it works

`backend/server.js` has a global authentication middleware (around line 409) that runs on every request. It checks the request path against a `publicPaths` array (around line 411). If the request matches a public path, the middleware calls `next()` and the handler runs normally. Otherwise:

1. **AJAX / JSON request** (`req.xhr`, or `Accept: application/json`) → returns `401 { error: 'Authentication required' }`.
2. **Regular browser request** → saves the original URL into `req.session.returnTo` and redirects to `/auth/login`. After successful login, the auth flow sends the user back to `returnTo` (falling back to `/sites` if nothing was saved).

Effectively: **any route you add that you want anonymous users to reach must be added to `publicPaths` explicitly**. This is intentional — it makes "is this endpoint public?" a grep-able, single-file question instead of a scattered audit across route files.

### The public path list

As of the initial commit, `publicPaths` in `backend/server.js` contains:

```js
const publicPaths = [
  '/',                    // Landing page (anonymous preview chat)
  '/mobile-builder.html', // Mobile builder (same as landing)
  '/mobile-app.html',     // Legacy mobile app
  '/auth/login',
  '/auth/signup',
  '/auth/verify-email',
  '/auth/resend-verification',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/magic-link',     // Magic link authentication
  '/auth/mfa-verify',     // MFA verification (during login flow)
  '/auth/mfa-setup',
  '/auth/mfa-backup-codes',
  '/auth/send-mfa-code',
  '/auth/google',
  '/auth/google/callback',
  '/mobile/auth',
  '/static',
  '/favicon.ico',
  '/health',
  '/api',                 // API info endpoints
  '/api/health',
  '/admin-panel',
];
```

Matching is prefix-based: a request path matches if it equals a listed path exactly **or** starts with `<listed>/`. So `/static` covers `/static/js/bundle.js`, `/api` covers `/api/info`, and so on.

### How to add a new public route

When you add a new route that anonymous users should reach, do both of these — neither alone is enough:

1. **Define the route** in the relevant router file (`backend/routes/*.js`) as normal. Don't add `ensureAuthenticated` middleware to it.
2. **Add its path prefix to the `publicPaths` array** in `backend/server.js`.

Example: you're adding a public `/pricing` page and a `/api/stats/public` JSON endpoint.

```js
// backend/server.js → publicPaths
const publicPaths = [
  '/',
  // ... existing entries ...
  '/pricing',              // ← add this
  '/api/stats/public',     // ← and this
];
```

```js
// backend/routes/index.js (or a new router)
router.get('/pricing', (req, res) => {
  res.render('pricing', { user: req.user || null });
});
```

Test with `curl -i http://localhost:8000/pricing` — if you see a `302` to `/auth/login`, the `publicPaths` entry is missing or doesn't match the path prefix correctly.

### How to protect a route that should require auth

Don't do anything. Just mount it normally outside of `publicPaths`. The global middleware will handle the redirect for browsers and the `401` for API clients automatically. You don't need to sprinkle `ensureAuthenticated` on every handler — it's already enforced at the middleware layer.

If you additionally need the user to have completed MFA (not just be logged in), use `ensureFullAuth` from `backend/middleware/authMiddleware.js` on the specific route. That's how `/chat`, `/account`, and the admin panel are gated.

### How to require MFA on a new route

```js
const { ensureFullAuth } = require('../middleware/authMiddleware');

router.get('/sensitive', ensureFullAuth, (req, res) => {
  // Only reached by logged-in users who have verified MFA this session
});
```

`ensureFullAuth` also redirects unauthenticated users to `/auth/login` and MFA-incomplete users to `/auth/mfa-verify`, both with `returnTo` preserved.

### Rules of thumb

- **Default to private.** Leave new routes out of `publicPaths` unless there's a concrete reason they need anonymous access.
- **Never expose write endpoints publicly** (POST/PUT/PATCH/DELETE). The template has `/api/leads` and `/api/preview/generate` as intentional public POSTs; every other write endpoint should require auth.
- **Be prefix-precise.** `/api` is public in the default list, which means `/api/health` and `/api/info` are public, **but so is every new `/api/foo` you add unless you think about it**. If you're adding authenticated API endpoints, gate them with `ensureFullAuth` on the route itself, or nest them under a non-public prefix.
- **AJAX routes still need to be on the list.** The 401-vs-redirect branch is *after* the `publicPaths` check — if you forget to list your public XHR endpoint, callers will get a 401 JSON error instead of a clean response.
- **Don't grep the route files to figure out what's public.** Grep `publicPaths` in `backend/server.js`. That's the single source of truth.

---

## Adding a deployment target

> **If the human asks for AWS Elastic Beanstalk specifically, stop and read [`deploy/eb/README.md`](deploy/eb/README.md) first.** A working single-tenant reference implementation is already committed there (CloudFormation + deploy script + Dockerfile.eb + entrypoint). It stands up its own VPC, RDS PostgreSQL, ElastiCache Redis, ECR repo, instance IAM role with `bedrock:InvokeModel`, and Secrets Manager entries for DB creds. Extend or customize that module; do not re-derive it from scratch.

> **If the human asks for AWS App Runner, read [`deploy/apprunner/README.md`](deploy/apprunner/README.md) first.** Same shape as the EB module (CloudFormation + three-phase deploy script + Dockerfile.apprunner + entrypoint + delete script), but the service runs on App Runner behind a VPC connector with interface endpoints for Secrets Manager, STS and Bedrock, no NAT by default, in-stack generated secrets, and an SES sender for the email-only sign-in. Extend that module; do not re-derive it.

The `Publish` button in the website builder currently hits a stub that marks every deployment as `not_configured`. Your job when a human asks for "deploy this to X" is to:

1. **Pick the target** based on what the human has and how they want to bill/tenant it.
2. **Write the IAC** for it (CloudFormation / Terraform / Pulumi / CDK / SAM / plain shell — whatever fits).
3. **Implement `triggerDeployment(site, deployment)`** in `backend/routes/sites.js` so the publish button actually deploys.
4. **Mirror the teardown** in the site-delete handler in the same file.
5. **Update the `Site` model** if you need per-site state (service name, URL, external ID, etc.). There are already optional columns (`lightsailServiceName`, `lightsailUrl`, `deploymentStatus`, `publishedConfig`, `lastDeployedAt`) you can repurpose or replace.

### Target selection

| Target | When to pick it |
|---|---|
| **AWS Elastic Beanstalk (single-instance Docker)** | **Reference implementation already exists in [`deploy/eb/`](deploy/eb/README.md).** Cheapest AWS-native single-tenant path, self-contained (its own VPC/RDS/Redis), rolls in ~20 min on a cold account. Pick this if the human wants AWS and doesn't specifically ask for something else. |
| **AWS App Runner** | **Reference implementation already exists in [`deploy/apprunner/`](deploy/apprunner/README.md).** Managed container service with rolling deploys and no instance to own; same self-contained VPC/RDS/Redis as the EB module. Pick this if the human wants AWS with zero-downtime redeploys or already runs other apps on App Runner. |
| **Amazon Lightsail (container service)** | Small-to-medium sites, predictable monthly pricing, you're already on AWS, want minimal surface area. Alternative to EB if you specifically want Lightsail's fixed-price container pricing model. |
| **Google Cloud Run** | Serverless containers, scales to zero, pay-per-request, you're already on GCP. Minimal ops. |
| **Fly.io / Railway / Render** | Global edge, push-to-deploy UX, small team, no dedicated DevOps. |
| **AWS ECS + Fargate** | You want AWS-native autoscaling, ALB integration, IAM-gated service-to-service auth, but don't want to run a cluster. |
| **AWS EKS / GKE / self-hosted K8s** | You already run Kubernetes for other workloads, or you need cluster-level features (CRDs, multi-namespace, sidecars). |
| **Vercel / Netlify** | Only works if you split the frontend out as a static SPA — not a great fit for this Express app as shipped. |
| **Bare VPS + systemd/Caddy/Nginx** | Minimum cost, maximum simplicity, one-machine sites. No orchestration, no magic. |

Ask the human about: expected traffic, budget, existing cloud relationships, whether they need multi-tenancy, and how much they want to pay in ongoing ops effort. Don't guess.

### Single-tenant vs multi-tenant

Two very different architectures — pick one up front, don't try to support both:

- **Single-tenant:** One deploy = one customer. Simplest. All published sites go into one container service / one project / one VPS. Site isolation is at the DB row level.
- **Multi-tenant (shared infra):** One deploy = many customers, but they share the hosting. Most SaaS apps. DB-level tenant isolation, row-level security, scoped API keys.
- **Multi-tenant with per-customer account:** Every customer gets their own AWS/GCP account. Maximum isolation, maximum cost per customer, useful for regulated/enterprise workloads. Requires the **bootstrap trust pattern** described below.

### The cross-account bootstrap pattern (abstract)

If the human asks you to build a multi-tenant platform where each customer gets their own cloud account, here's the standard recipe — expressed abstractly so you can re-derive it for any cloud:

1. The **platform account** holds the application code and the identity that runs it.
2. Each **customer account** holds a **trust role** with a tightly-scoped policy (only the actions your deploys need — e.g. create a container service, write a DNS record, read an image).
3. The trust role's trust policy allows assumption **only** from a specific principal in the platform account, gated by an **external ID** unique to that customer (protects against confused-deputy attacks).
4. The platform code calls `AssumeRole` at request time to get short-lived credentials for the customer account, does the deploy, lets the credentials expire.
5. Customer accounts are bootstrapped by deploying the trust role via a **per-cloud org-wide mechanism**:
   - **AWS:** CloudFormation StackSets targeted at an AWS Organizations Organizational Unit. One template, many accounts, automatic rollout on new-account join.
   - **GCP:** Organization-level IAM policies and Deployment Manager.
   - **Azure:** Management Groups + Azure Policy assignments or Blueprints.

**Rules when implementing this pattern:**

- Never hardcode account IDs, role names, or ARNs in code or docs you commit. Use env vars or a `customers` table.
- The trust role's policy must be **least privilege** — if you only need to manage Lightsail + Route53, don't grant `*`.
- The external ID must be generated per-customer and stored alongside the customer row, not derived from anything guessable.
- If the deploy target's credentials are ever logged, redact them.
- **Do not** store long-lived customer credentials — only fetch short-lived ones via AssumeRole at request time.
- Point the human at the official cloud vendor docs for the specific mechanics — don't invent trust policy JSON from memory.

### Wiring it into `triggerDeployment()`

The stub in `backend/routes/sites.js` is the single integration point. Your implementation should, in order:

1. Mark the `Deployment` row as `building` via `deployment.markAsBuilding()`.
2. Resolve credentials for the target (AssumeRole, service account key, kubeconfig, API token — whatever your target needs). Pull secrets via `secretsManager.js` in production mode, env vars in development mode (mirror the `NODE_ENV` gate used elsewhere).
3. Provision any missing infrastructure for this site (container service, DNS record, TLS cert, …).
4. Build and push the site bundle. For static sites, the existing `backend/docker/site-renderer/` is a starting point.
5. Wait for the deploy to become healthy (or set a sensible timeout).
6. Write the final URL and target-specific identifiers back to the `Site` row.
7. Call `deployment.markAsSuccess(<identifier>)` on success or `deployment.markAsFailed(<reason>)` on failure.

Keep the heavy lifting in a new file under `backend/services/deploy/` rather than cramming it into `routes/sites.js`.

### CORS for deployed environments (every deployment target — read before shipping)

`backend/server.js:49-95` uses a **default-deny CORS allowlist**. Any origin that doesn't match one of the rules below gets a `500` + `Error: Not allowed by CORS` and the app never even reaches the handler. This bites every first-time deploy because the deploy target's public hostname is never in the allowlist by default.

The three allow rules, in order:

1. **`origin` is falsy** (mobile apps, Postman, server-to-server) → allowed.
2. **`localhost`** on any port, http or https → allowed (dev only).
3. **`DOMAIN` env var** → allows `https://<anything>.${DOMAIN}` (subdomain pattern, `https` only). Use this when you own a domain and are running a multi-tenant platform under `*.yourdomain.com`.
4. **`CUSTOM_DOMAIN` env var** → comma-separated list of exact hostnames, matched as either `http://<host>` or `https://<host>`. Use this for single-tenant deploys or when the hostname doesn't fit the subdomain pattern (e.g. EB default URLs, Cloud Run default URLs, ngrok tunnels).

**Symptom when CORS is misconfigured:**
- Browser: `POST /api/preview/generate` returns HTTP 500.
- Container log: `CORS blocked origin: http://your-deploy-hostname ... Error: Not allowed by CORS`.
- It looks like the LLM is broken; it isn't — the request never reaches the LLM layer.

**Required: wire the deploy hostname into `CUSTOM_DOMAIN` automatically.** Do NOT leave this as a "user fills in `.env` later" step — every first-time user will hit the CORS 500 and think Bedrock / OpenAI / Anthropic is broken. For any deployment target you add (`triggerDeployment()` or a top-level `deploy/<target>/`), the deploy script or IAC must:

1. Read the target's assigned public hostname **after** provisioning (often only available post-create — EB CNAME, Cloud Run URL, ECS ALB DNS, etc.).
2. Patch it into the running environment's `CUSTOM_DOMAIN` var (e.g. `aws elasticbeanstalk update-environment`, `gcloud run services update`, `aws ecs update-service` with task-def revision).
3. Wait for the update to roll out before printing the "Deploy complete" banner.

The EB reference implementation at [`deploy/eb/deploy.sh`](deploy/eb/deploy.sh) does this explicitly — copy the pattern.

If the deploy will later be fronted by a custom domain + TLS via ACM/Cloudflare/Let's Encrypt, add that hostname to `CUSTOM_DOMAIN` **in addition to** the cloud-provider default URL, not instead of — users will hit both during the cutover.

---

## Rules for any code you add

1. **Portability is non-negotiable.** Self-hosted and managed-hosting deploys run the same code. Gate production-only behavior on `NODE_ENV === 'production'`, not on feature flags or separate files.
2. **No hardcoded account IDs, role names, or URLs** — even placeholder ones that look real. Use env vars, and document them in `.env.example` and `README.md`.
3. **Secrets from Secrets Manager in production, env vars in development** — match the pattern in `backend/config/database.js` and `backend/services/emailService.js`.
4. **Never commit `.env`, keystores, or credentials.** The `.gitignore` already excludes `.env*` except for `.env.example`; don't add exceptions.
5. **CSP compliance.** `backend/server.js` sets strict CSP with no `unsafe-inline`. Use nonces for any new inline scripts/styles and prefer class toggles over `element.style.foo` in frontend JS.
6. **i18n.** English and Hebrew are both supported. Any user-facing string goes in `backend/i18n/en.json` *and* `he.json`; templates use `<%= t('key') %>`, client JS uses `_t('key')`.
7. **Migrations are forward-only.** If you need to change the schema, add a new migration file; never edit an existing one.
8. **Run the dev loop locally before shipping.** At minimum: `npm run install:all`, `npx sequelize-cli db:migrate`, `npm run dev`, `curl localhost:8000/health`.
9. **Document as you go.** Every new env var goes in `.env.example`. Every new extension point gets a short section in this file or in `README.md`.

---

## Working with a human

When the human asks you to extend the template, ask the following before writing code:

1. **What are they building?** A SaaS, an internal tool, a demo, a multi-tenant platform? This changes the architecture decisions.
2. **Where will it run?** Single region, global, on-prem, air-gapped? Which cloud (if any)?
3. **What's the budget?** Predictable monthly pricing vs. pay-per-use changes the target recommendation.
4. **How will users sign up and pay?** Affects auth, tenant model, admin UI needs.
5. **What does "publish" mean for their use case?** For some it's "one static site per user". For others it's "spin up a whole customer environment". Very different implementations.

If the human has a vague request like "deploy this", default to **single-tenant on Lightsail or Cloud Run** and confirm with them before building anything else — those are the cheapest and fastest to stand up.

Once you have answers, write a short plan in the conversation (not in a new file), get approval, then implement. Keep commits focused: "Add Cloud Run deployment target" is one commit, not five.
