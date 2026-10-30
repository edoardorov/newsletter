#!/usr/bin/env node
// Builds one edition of The Recap with Perplexity and merges it into data/stories.json.
// Run by .github/workflows/update.yml three times a day; can also be run by hand:
//   PERPLEXITY_API_KEY=... node scripts/update.mjs --edition=AM
// MOCK=1 uses a canned answer (no API call) to test the pipeline.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { askPerplexity, parseJSON, stripCites, hostOf } from '../lib/perplexity.mjs';
import { eventWindow } from '../lib/market.mjs';
import { THEMES, REGIONS, ASSETS, cleanStory, slug } from '../lib/taxonomy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'stories.json');
const KEEP_DAYS = 183;

const EDITIONS = {
  AM: { label: 'Morning', time: '08:00', window: [7 * 60, 8 * 60], since: 'the previous evening edition (21:30 UK yesterday)', focus: 'overnight US after-hours results, Asian markets, UK and European company results and data released before 08:00 UK, crypto overnight, and geopolitics' },
  MD: { label: 'Afternoon', time: '15:30', window: [14 * 60 + 30, 15 * 60 + 30], since: 'this morning’s 08:00 UK edition', focus: 'the European session, UK/European data and company news, US economic releases, US pre-market movers and the first hour of US trading, and crypto' },
  PM: { label: 'Evening', time: '21:30', window: [20 * 60 + 30, 21 * 60 + 30], since: 'this afternoon’s 15:30 UK edition', focus: 'the US close (indices, sectors, biggest movers), US after-hours earnings, European closes, crypto, and evening macro or geopolitical news' },
};

function ukNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}

function chooseEdition(now) {
  const arg = (process.argv.find((a) => a.startsWith('--edition=')) || '').split('=')[1] || process.env.EDITION || '';
  const forced = arg.trim().toUpperCase();
  if (EDITIONS[forced]) return { ed: forced, forced: true };
  for (const [k, e] of Object.entries(EDITIONS)) {
    if (now.minutes >= e.window[0] && now.minutes < e.window[1]) return { ed: k, forced: false };
  }
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    // Manual run outside a window: build the most recent edition.
    const ed = now.minutes >= 21 * 60 + 30 ? 'PM' : now.minutes >= 15 * 60 + 30 ? 'MD' : 'AM';
    return { ed, forced: true };
  }
  return null;
}

const STORY_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' }, dek: { type: 'string' },
          body: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string', enum: ['Macro', 'Micro'] },
          region: { type: 'string', enum: REGIONS },
          asset: { type: 'string', enum: ASSETS },
          sentiment: { type: 'string', enum: ['Positive', 'Negative', 'Neutral'] },
          themes: { type: 'array', items: { type: 'string', enum: THEMES } },
          keywords: { type: 'array', items: { type: 'string' } },
          companies: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, ticker: { type: 'string' }, listed: { type: 'boolean' }, move: { type: ['number', 'null'] } },
              required: ['name', 'ticker', 'listed', 'move'],
            },
          },
          coverage: { type: 'number' }, impact: { type: 'number' },
          sources: { type: 'array', items: { type: 'object', properties: { publisher: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] } },
        },
        required: ['title', 'dek', 'body', 'scope', 'region', 'asset', 'sentiment', 'themes', 'keywords', 'companies', 'coverage', 'impact', 'sources'],
      },
    },
  },
  required: ['stories'],
};

function buildPrompt(edKey, today, earlierTitles) {
  const e = EDITIONS[edKey];
  const instructions = [
    'You are the editor of "The Recap", a concise daily financial news briefing for an investor covering UK & Europe, US, and crypto & alternatives.',
    'Search the web for the most important, market-moving financial news and write it up accurately in your own words.',
    'Rules: use only facts stated by reputable sources you found; never invent figures, share moves, quotes or events; prefer primary and major financial outlets (Reuters, Bloomberg, FT, CNBC, WSJ, company releases, central banks, CoinDesk).',
    'Return JSON only, matching the schema. No commentary outside the JSON.',
  ].join('\n');
  const input = [
    `Today is ${today} (UK). Build the ${e.label.toUpperCase()} edition, published at ${e.time} UK.`,
    `Cover news since ${e.since}, focusing on ${e.focus}.`,
    'Return 10 to 12 stories, ordered from most to least important, with a balance of macro (central banks, data, rates, FX, commodities, geopolitics) and micro (results, guidance, M&A, big single-stock moves), and at least one crypto or alternatives story when there is real news.',
    earlierTitles.length ? `These stories were already published earlier today; do not repeat them unless there is a material new development, which you should then write up as the development:\n- ${earlierTitles.join('\n- ')}` : '',
    'Field guidance:',
    '- title: one sentence headline. dek: one sentence. body: 1 to 3 short paragraphs of plain prose with concrete numbers. No citation markers like [1].',
    `- themes: 1 to 3 from: ${THEMES.join(', ')}. The first is the main theme.`,
    '- keywords: 4 short key terms.',
    '- companies: only companies central to the story. ticker = the Yahoo Finance symbol (e.g. AAPL, AZN.L, BT-A.L, SAP.DE, MC.PA, 7203.T); listed = false for private companies; move = the % share move reported by sources (negative for falls) or null if not reported.',
    '- coverage: 0 to 1, how widely the story is covered across outlets. impact: 0 to 1, size of the market reaction.',
    '- sources: 1 to 3 of the pages you used, with publisher, title and full URL.',
  ].filter(Boolean).join('\n');
  return { instructions, input };
}

const MOCK_ANSWER = {
  stories: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({
    title: `Mock headline ${i} [1]`, dek: 'Mock dek.', body: ['Mock body paragraph [web:2].'],
    scope: i % 2 ? 'Macro' : 'Micro', region: 'UK', asset: 'Equities', sentiment: 'Neutral',
    themes: ['Earnings', 'NotATheme'], keywords: ['a', 'b', 'c', 'd'],
    companies: i % 3 ? [] : [{ name: 'Mock plc', ticker: 'mock.l', listed: true, move: 1.234 }],
    coverage: 0.6, impact: 70, sources: [{ publisher: 'Example', title: 'Example source', url: 'https://example.com/a' }],
  })),
};

async function main() {
  const now = ukNow();
  const choice = chooseEdition(now);
  if (!choice) { console.log(`Not an edition window (UK ${now.date} ${Math.floor(now.minutes / 60)}:${String(now.minutes % 60).padStart(2, '0')}). Nothing to do.`); return; }
  const { ed, forced } = choice;

  let data;
  try { data = JSON.parse(await readFile(DATA_FILE, 'utf8')); } catch { data = { stories: [] }; }
  data.stories = Array.isArray(data.stories) ? data.stories : [];

  if (!forced && data.stories.some((s) => s.date === now.date && s.ed === ed)) {
    console.log(`${ed} edition for ${now.date} already published. Skipping.`);
    return;
  }

  const earlier = data.stories.filter((s) => s.date === now.date && s.ed !== ed).map((s) => s.title);
  const { instructions, input } = buildPrompt(ed, now.date, earlier);

  let parsed, results = [];
  if (process.env.MOCK) {
    parsed = MOCK_ANSWER;
  } else {
    const ans = await askPerplexity({ instructions, input, effort: process.env.PPLX_EFFORT || 'low', schema: STORY_SCHEMA, recency: 'day' });
    results = ans.results;
    parsed = parseJSON(ans.text);
  }
  const raw = Array.isArray(parsed) ? parsed : parsed.stories;
  if (!Array.isArray(raw)) throw new Error('Perplexity answer had no stories array');

  const known = new Set(results.map((r) => r.url));
  const usedIds = new Set();
  const fresh = raw.map((s) => {
    const c = cleanStory(s, { stripCites });
    let sources = (Array.isArray(s.sources) ? s.sources : [])
      .filter((x) => x && /^https?:\/\//.test(x.url || ''))
      .map((x) => ({ pub: String(x.publisher || x.pub || hostOf(x.url)), title: stripCites(x.title || x.url).slice(0, 200), url: x.url }));
    if (known.size) {
      const verified = sources.filter((x) => known.has(x.url));
      if (verified.length) sources = verified;
    }
    if (!sources.length && results.length) sources = results.slice(0, 2).map((r) => ({ pub: r.source, title: r.title, url: r.url }));
    let id = `${now.date.replace(/-/g, '')}-${ed.toLowerCase()}-${slug(c.title)}`;
    while (usedIds.has(id)) id += '-x';
    usedIds.add(id);
    return { id, date: now.date, ed, ...c, sources };
  }).filter((s) => s.title && s.body.length);

  if (fresh.length < 6) throw new Error(`Only ${fresh.length} usable stories; keeping the previous data.`);

  const cutoff = new Date(Date.parse(now.date) - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const kept = data.stories.filter((s) => s.date >= cutoff && !(s.date === now.date && s.ed === ed));
  const stories = [...fresh, ...kept];

  // Event-window prices: new stories, plus refresh stories from the last 10 days so the "after" side fills in.
  if (!process.env.MOCK) {
    const recent = new Date(Date.parse(now.date) - 10 * 86400000).toISOString().slice(0, 10);
    const jobs = [];
    for (const s of stories) {
      if (s.date < recent) continue;
      for (const c of s.companies || []) {
        jobs.push(eventWindow(c.ticker, s.date).then((w) => { c.series = w.series; c.dates = w.dates; c.eventIndex = w.eventIndex; c.currency = w.currency; }).catch(() => {}));
      }
    }
    await Promise.all(jobs);
  }

  const out = { today: now.date, updated: new Date().toISOString(), edition: ed, stories };
  await writeFile(DATA_FILE, JSON.stringify(out, null, 1) + '\n');
  console.log(`Published ${ed} edition for ${now.date}: ${fresh.length} stories (${stories.length} in archive).`);
  console.log(`Top story: ${fresh[0].title}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
