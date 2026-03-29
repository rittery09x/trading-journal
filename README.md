# Trading Journal

Private IBKR options trading journal — Next.js frontend, FastAPI grouping engine, Supabase database.

Live: **https://trading.cari-digital.de**

---

## Stack

| Layer      | Technology                          |
|------------|-------------------------------------|
| Frontend   | Next.js 14 (App Router, standalone) |
| Backend    | Python 3.11 / FastAPI               |
| Database   | Supabase (PostgreSQL + Auth)        |
| Deployment | Coolify on a VPS                    |
| Proxy      | Traefik (managed by Coolify)        |

---

## Prerequisites

1. A **Supabase** project (free tier is enough)
2. A **Coolify** server (self-hosted or cloud)
3. An **IBKR** account with Flex Query access

---

## 1 — Supabase Setup

### 1.1 Run migrations

In the Supabase dashboard → **SQL Editor**, run the migration files in order:

```
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_add_grouping_fields.sql
```

### 1.2 Enable Email Auth

Dashboard → **Authentication → Providers → Email** — ensure it is enabled.
Disable "Confirm email" (single-user private app, no email confirmation needed).

### 1.3 Create your user

Dashboard → **Authentication → Users → Add user**:

- Email: your login email
- Password: choose a strong password
- ✓ Auto Confirm User

### 1.4 Copy credentials

From **Project Settings → API**:

| Variable                    | Where to find it                      |
|-----------------------------|---------------------------------------|
| `NEXT_PUBLIC_SUPABASE_URL`  | Project URL                           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / `public` key             |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key (keep secret!)    |

---

## 2 — IBKR Flex Query Setup

### 2.1 Create the Flex Web Service Token

IBKR Account Management → **Reports → Flex Queries → Manage Flex Web Service**
→ Generate a token → copy it as `IBKR_FLEX_TOKEN`.

### 2.2 Create two Flex Queries

**Activity Statement** (covers executions, dividends, stock positions):
- Sections: Trades, Open Positions, Cash Transactions
- Period: Last 30 Days (or custom)
- Format: XML
- Copy the Query ID → `FLEX_QUERY_ID_ACTIVITY`

**Trade Confirmations** (provides the `code` field for assignment/expiry detection):
- Sections: Trade Confirmations
- Period: Last 30 Days
- Format: XML
- Copy the Query ID → `FLEX_QUERY_ID_CONFIRMS`

---

## 3 — Coolify Deployment

### 3.1 Create a new resource

Coolify dashboard → **+ New Resource → Docker Compose**
→ Connect your GitHub repository (or use a Git URL).

### 3.2 Configure the service

| Setting            | Value                              |
|--------------------|------------------------------------|
| Docker Compose file | `docker-compose.yml` (repo root)  |
| Domain             | `trading.cari-digital.de`          |
| Port               | `3000`                             |
| Branch             | `main`                             |

### 3.3 Set Environment Variables

In Coolify → **Environment Variables**, add every variable from the table below.

> **Important:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
> must also be set as **Build Variables** (Coolify → Build Variables tab),
> because Next.js bakes them into the client bundle at compile time.

| Variable                        | Required | Description                              |
|---------------------------------|----------|------------------------------------------|
| `NEXT_PUBLIC_SUPABASE_URL`      | ✓        | Supabase project URL                     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓        | Supabase anon key                        |
| `SUPABASE_SERVICE_ROLE_KEY`     | ✓        | Supabase service role key (server only)  |
| `FLEX_QUERY_TOKEN`              | ✓        | IBKR Flex Web Service token              |
| `FLEX_QUERY_ID_ACTIVITY`        | ✓        | IBKR Activity Statement query ID         |
| `FLEX_QUERY_ID_CONFIRMS`        | ✓        | IBKR Trade Confirms query ID             |
| `IMPORT_SECRET`                 | ✓        | Bearer token for `/api/import/flex`      |
| `NEXT_PUBLIC_APP_URL`           | ✓        | `https://trading.cari-digital.de`        |
| `SMTP_HOST`                     | optional | SMTP server for weekly report emails     |
| `SMTP_PORT`                     | optional | Default: `587`                           |
| `SMTP_USER`                     | optional | SMTP username                            |
| `SMTP_PASS`                     | optional | SMTP password                            |
| `REPORT_EMAIL`                  | optional | Empfänger-Adresse für Wochenreport       |

### 3.4 Deploy

Click **Deploy**. Coolify will:
1. Clone the repo
2. Build the backend Docker image
3. Build the frontend Docker image (with the NEXT_PUBLIC build args)
4. Start both containers
5. Configure Traefik routing + SSL for `trading.cari-digital.de`

First deploy takes 3–5 minutes (npm install + next build).

### 3.5 Verify

| URL                                              | Expected                    |
|--------------------------------------------------|-----------------------------|
| `https://trading.cari-digital.de`               | Redirects to `/login`       |
| `https://trading.cari-digital.de/login`          | Login form                  |
| `https://trading.cari-digital.de:8000/health`   | `{"status":"ok"}` (internal)|

> The backend port (8000) is **not** exposed externally — it's only reachable
> inside the Docker network as `http://backend:8000`.

---

## 4 — Local Development

### 4.1 Frontend only (recommended)

```bash
cd frontend
cp .env.local.example .env.local
# Fill in your Supabase URL, anon key, and service role key
# Set PYTHON_PARSER_URL=http://localhost:8000

npm install
npm run dev          # http://localhost:3000
```

### 4.2 Full stack via Docker Compose

```bash
# In the repo root:
cp .env.example .env
# Fill in all values

docker-compose up --build
# Frontend: http://localhost:3000
# Backend:  http://localhost:8000/docs
```

### 4.3 Backend only

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload   # http://localhost:8000/docs
```

---

## 5 — First Import

1. Open `https://trading.cari-digital.de/import`
2. Enter your `IMPORT_SECRET`
3. Click **Import starten** — the app fetches both IBKR Flex Queries, parses
   them, runs the grouping engine, and upserts everything into Supabase
4. Takes 15–60 s depending on IBKR server response time

Re-running import is fully idempotent (deterministic UUIDs for all records).

---

## 6 — Weekly Report (optional)

POST to `/api/weekly-report` with the same `Authorization: Bearer <IMPORT_SECRET>` header.
Add this as a cron job on your server or via a cron service:

```bash
curl -X POST https://trading.cari-digital.de/api/weekly-report \
  -H "Authorization: Bearer YOUR_IMPORT_SECRET"
```

---

## 7 — Updating the App

Push to `main` → Coolify auto-deploys (if webhooks are configured) or click
**Redeploy** in the Coolify dashboard.

> If you change `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
> you must trigger a full rebuild (not just a restart) because these values
> are baked into the Next.js client bundle at build time.
