# The Recap

A public financial-news website that publishes itself three times a day using Perplexity.

- **Today** — the 08:00, 15:30 and 21:30 UK editions, 10–12 stories each, tiles sized by score.
- **Personal** — search and filter the 6-month archive, a watchlist, and live Perplexity research on any topic with live share prices.
- Every story links to its sources and shows the share move and a before/after daily-close chart for listed companies.

## How it runs

| Part | What it does | Where |
|---|---|---|
| `scripts/update.mjs` | Asks Perplexity (Agent API, `/v1/agent`) for the edition, cleans it, adds price history, prunes anything older than 6 months, writes `data/stories.json` | GitHub Actions |
| `.github/workflows/update.yml` | Runs the script at 07:40, 15:10 and 21:10 UK and commits the result | GitHub Actions |
| `index.html` | The website. Reads `data/stories.json`, refreshes every 5 minutes | Vercel |
| `api/research.js` | Live research for the Personal tab (Perplexity + live prices) | Vercel function |
| `api/quote.js` | Live share prices (Yahoo Finance) | Vercel function |

Each commit from the workflow redeploys the site on Vercel automatically.

## Set-up (about 10 minutes, once)

1. **Perplexity API key** — at perplexity.ai → Settings → API, add credit and create a key.
2. **GitHub** — create a new repository and upload everything in this folder (drag the files into “Add file → Upload files”, keeping the `.github` folder).
3. **Key for the editions** — in the repository: Settings → Secrets and variables → Actions → New repository secret, name `PERPLEXITY_API_KEY`.
4. **Vercel** — at vercel.com, “Add New → Project”, import the repository, add the environment variable `PERPLEXITY_API_KEY`, and deploy. Your public link is shown at the end (you can add your own domain under Settings → Domains).
5. **First edition** — in GitHub: Actions → “Publish edition” → Run workflow. From then on it runs on its own.

## Keeping live research private

Your Perplexity key is only ever used on the server; visitors never see it. Live research on the Personal tab would spend your credit, so it is **off for everyone until you set a code**:

1. Vercel → your project → Settings → Environment Variables → add `RESEARCH_PASSCODE` with a code only you know → then Deployments → ⋯ → Redeploy.
2. On the site, Personal tab → “Owner? Unlock live research” → enter the code once. That browser stays unlocked until you press Lock.

Visitors can still read every edition, search and filter the archive, and use their own watchlist. The three daily editions cost the same however many people visit.

## Options (Vercel environment variables)

- `RESEARCH_PASSCODE` — required to switch on live research (see above).
- `RESEARCH_LIMIT_PER_HOUR` — research requests per visitor per hour (default 20).
- `PPLX_EFFORT` (GitHub secret or workflow env) — `low` (default) or `medium` for more thorough editions.

## Test locally

```
npm run update:mock     # runs the pipeline with a canned answer, no API call
npx vercel dev          # serves the site and the /api functions
```

Prices come from Yahoo Finance’s public endpoint and may be delayed. Not investment advice.
