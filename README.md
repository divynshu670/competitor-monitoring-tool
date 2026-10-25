# Competitor Monitoring Tool

## Project overview

This tool scans a competitor website for blog articles, stores discovered articles in PostgreSQL, and reports which ones are new. Newly discovered articles can optionally be enriched with keyword data and sent in a Gmail email digest.

## Tech stack

- Node.js 20.18.1 or later and TypeScript
- Express for the HTTP API
- Cheerio for HTML and sitemap parsing
- PostgreSQL with `pg` for article persistence
- DataForSEO for optional keyword enrichment
- Gmail SMTP with Nodemailer for optional email alerts
- Zod and dotenv for configuration
- Vitest and Supertest for automated tests

## Features

- Discovers article links from a website homepage, common content sections, and sitemaps.
- Extracts article titles, URLs, publication dates, and meta descriptions where available.
- Uses PostgreSQL to remember articles and avoid reporting the same article twice for the same competitor.
- Optionally enriches new articles with DataForSEO keyword suggestions and estimated search volumes.
- Optionally sends one Gmail digest for new articles. Email failures do not undo stored articles.
- Checks URLs and bounds scraping requests with redirect, response-size, and timeout limits.
- Pricing-page change monitoring is not implemented.

## Requirements

- Node.js 20.18.1 or later (required by Cheerio)
- npm 9 or later
- PostgreSQL for scanning and article storage

The server and health endpoint can run without PostgreSQL configuration. Scanning requires a reachable PostgreSQL database.

## Local setup

Install dependencies and create your local environment file:

```powershell
npm install
Copy-Item .env.example .env
```

Open `.env` and enter your own PostgreSQL connection settings. The database and user must already exist and be accessible to the application. Optional provider settings can be left blank. Keep `.env` private; do not commit it.

## Environment variables

| Variable | Purpose | Required when |
|---|---|---|
| `PORT` | Server port; defaults to `3000` | Optional |
| `PGHOST` | PostgreSQL host | Scanning |
| `PGPORT` | PostgreSQL port; defaults to `5432` | Optional for scanning |
| `PGDATABASE` | PostgreSQL database name | Scanning |
| `PGUSER` | PostgreSQL username | Scanning |
| `PGPASSWORD` | PostgreSQL password | Scanning |
| `DATAFORSEO_LOGIN` | DataForSEO API login | Optional keyword enrichment |
| `DATAFORSEO_PASSWORD` | DataForSEO API password | Optional keyword enrichment |
| `GMAIL_USER` | Gmail sender account | Optional email alerts |
| `GMAIL_APP_PASSWORD` | Google App Password for SMTP | Optional email alerts |
| `ALERT_TO_EMAIL` | Alert recipient | Optional email alerts |

Keyword enrichment requires DataForSEO credentials. Provider usage may incur charges; review its current pricing before enabling it. Email alerts require all three Gmail settings and a Google App Password, not your regular Gmail password.

## Run the application

Start the development server:

```powershell
npm run dev
```

Build and run the compiled application:

```powershell
npm run build
npm start
```

Run automated tests with `npm test`.

## API endpoints

### `GET /health`

Returns HTTP 200 when the application is running. It does not require database or provider credentials.

### `POST /scrape`

Send a competitor domain in JSON:

```json
{
  "domain": "https://example.com"
}
```

The response includes discovered and new article counts, article details, keyword enrichment status, and email delivery status. A valid request returns HTTP 503 with a database setup-required message when PostgreSQL settings are missing. Invalid requests return HTTP 400.

Successful scans return HTTP 200. Invalid input or prohibited URLs return HTTP 400; network timeouts or blocked targets return HTTP 502; missing database configuration returns HTTP 503. Unexpected scan or article-persistence failures return HTTP 500. Keyword-persistence failures are reported in `keywordEnrichment.status`; they do not undo discovered articles.

## Deployment note

For a public Vercel deployment without credentials, the health endpoint can confirm the app is running; scanning requires PostgreSQL configuration and returns HTTP 503 until it is provided. A deployed scan also needs a PostgreSQL database reachable from Vercel. Evaluators can clone the repository, create their own `.env`, configure their own database, and run scans locally. Optional provider features require their respective credentials. The Express app is in `src/server.ts`; no additional Vercel configuration file is currently included.

## Project structure

```text
src/
  server.ts             Express app and local server
  config.ts             Environment loading and validation
  db.ts                 PostgreSQL connection pool
  articles.ts           Article persistence and new-article detection
  keywords.ts            Optional keyword enrichment
  email.ts               Optional Gmail digest delivery
  routes/
    health.ts            Health endpoint
    scrape.ts             Scan API endpoint
  scraper/
    index.ts              Scrape workflow
    discover.ts           Candidate article discovery
    extract.ts            Article and sitemap parsing
    fetch.ts              Bounded page fetching
    guard.ts              URL and DNS safety checks
    types.ts              Shared data types
tests/                    Automated tests and local fixtures
```
