// POST /api/research  { topic, depth: "quick" | "deep" }
// Instant research: Perplexity web search + live prices for listed companies.
import { askPerplexity, parseJSON, stripCites } from '../lib/perplexity.mjs';
import { quotes } from '../lib/market.mjs';
import { THEMES } from '../lib/taxonomy.mjs';
import { timingSafeEqual } from 'node:crypto';

const cache = new Map(); // topic|depth -> { at, body }
const hits = new Map(); // ip -> [timestamps]
const CACHE_MS = 10 * 60 * 1000;
const LIMIT_PER_HOUR = Number(process.env.RESEARCH_LIMIT_PER_HOUR || 20);

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    keyPoints: { type: 'array', items: { type: 'string' } },
    scope: { type: 'string', enum: ['Macro', 'Micro', 'Mixed'] },
    themes: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, ticker: { type: 'string' }, exchange: { type: 'string' }, listed: { type: 'boolean' } },
        required: ['name', 'ticker', 'listed'],
      },
    },
  },
  required: ['summary', 'keyPoints', 'scope', 'themes', 'keywords', 'companies'],
};

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  list.push(now);
  hits.set(ip, list);
  return list.length > LIMIT_PER_HOUR;
}

function codeMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  // Live research spends the owner's Perplexity credit, so it is private:
  // it only runs for someone holding RESEARCH_PASSCODE. Without that variable it is off for everyone.
  const code = process.env.RESEARCH_PASSCODE;
  if (!code) return res.status(403).json({ error: 'not_configured' });
  if (!codeMatches(req.headers['x-passcode'], code)) return res.status(401).json({ error: 'passcode' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (body?.unlock) return res.status(200).json({ ok: true });
  const topic = String(body?.topic || '').trim().slice(0, 200);
  const depth = body?.depth === 'deep' ? 'deep' : 'quick';
  if (!topic) return res.status(400).json({ error: 'Missing topic' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const key = `${topic.toLowerCase()}|${depth}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return res.status(200).json(cached.body);
  if (limited(ip)) return res.status(429).json({ error: 'Too many research requests. Try again later.' });

  const today = new Date().toISOString().slice(0, 10);
  try {
    const ans = await askPerplexity({
      effort: depth === 'deep' ? 'medium' : 'fast',
      recency: depth === 'deep' ? 'month' : 'week',
      schema: SCHEMA,
      timeoutMs: depth === 'deep' ? 55000 : 25000,
      instructions: 'You are a financial research assistant. Search the web for the latest, most important news on the topic and answer accurately and concisely. Use only facts from reputable sources; never invent figures. Return JSON only.',
      input: [
        `Today is ${today}. Topic: "${topic}".`,
        'summary: 3-4 sentences on the current picture, with concrete numbers and dates. No citation markers.',
        'keyPoints: up to 5 short bullet points on the most important recent developments.',
        'scope: Macro, Micro or Mixed.',
        `themes: up to 4 from ${THEMES.join(', ')}.`,
        'keywords: up to 5 key terms.',
        'companies: up to 6 companies central to the topic. ticker = the Yahoo Finance symbol (AAPL, AZN.L, BT-A.L, SAP.DE, MC.PA); listed = false for private companies, with ticker "".',
      ].join('\n'),
    });
    const r = parseJSON(ans.text);
    const companies = (Array.isArray(r.companies) ? r.companies : []).slice(0, 6).map((c) => ({
      name: stripCites(c.name), ticker: c.listed && c.ticker ? String(c.ticker).toUpperCase() : '', exchange: String(c.exchange || ''), listed: !!(c.listed && c.ticker),
    }));
    const live = await quotes(companies.filter((c) => c.listed).map((c) => c.ticker));
    const out = {
      topic,
      depth,
      generatedAt: new Date().toISOString(),
      summary: stripCites(r.summary),
      keyPoints: (r.keyPoints || []).map(stripCites).slice(0, 5),
      scope: r.scope || 'Mixed',
      themes: (r.themes || []).filter((t) => THEMES.includes(t)).slice(0, 4),
      keywords: (r.keywords || []).map(stripCites).slice(0, 5),
      companies: companies.map((c) => ({ ...c, quote: c.listed ? live[c.ticker] || null : null })),
      news: ans.results.slice(0, 8),
    };
    cache.set(key, { at: Date.now(), body: out });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(out);
  } catch (e) {
    const status = e.status === 401 || e.status === 403 ? 502 : 500;
    return res.status(status).json({ error: 'Research failed. Please try again.', detail: String(e.message || e).slice(0, 200) });
  }
}
