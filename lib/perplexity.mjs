// Perplexity Agent API client (https://docs.perplexity.ai).
// The legacy Sonar endpoint was retired on 27 Sep 2026; this uses POST /v1/agent.
const ENDPOINT = 'https://api.perplexity.ai/v1/agent';

async function post(body, key, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

export function extractText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (typeof c.text === 'string') parts.push(c.text);
      }
    }
  }
  if (parts.length) return parts.join('');
  return data.choices?.[0]?.message?.content || '';
}

export function extractResults(data) {
  const out = [];
  for (const item of data?.output || []) {
    if (item.type === 'search_results') out.push(...(item.results || []));
  }
  if (!out.length && Array.isArray(data?.search_results)) out.push(...data.search_results);
  return out
    .filter((r) => r && r.url)
    .map((r, i) => ({
      id: r.id ?? i + 1,
      title: String(r.title || r.url),
      url: String(r.url),
      source: String(r.source || hostOf(r.url)),
      date: r.date || r.last_updated || '',
      snippet: String(r.snippet || ''),
    }));
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Removes inline citation markers like [1], [web:3], [1][2].
export function stripCites(s) {
  return String(s || '').replace(/\s*\[(?:web:)?\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Lenient JSON extraction: handles ```json fences and leading/trailing prose.
export function parseJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error('No JSON found in Perplexity answer');
  const open = t[start], close = open === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  return JSON.parse(t.slice(start, end + 1));
}

export async function askPerplexity({ instructions, input, effort = 'low', schema, recency, domains, timeoutMs = 240000, apiKey }) {
  const key = apiKey || process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error('PERPLEXITY_API_KEY is not set');
  const filters = {};
  if (recency) filters.search_recency_filter = recency;
  if (domains && domains.length) filters.search_domain_filter = domains;
  const body = {
    effort,
    instructions,
    input,
    tools: [Object.keys(filters).length ? { type: 'web_search', filters } : { type: 'web_search' }],
    stream: false,
  };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'output', schema } };

  let res = await post(body, key, timeoutMs);
  if (!res.ok && schema && res.status === 400) {
    // Fall back to prompt-only JSON if this account/effort rejects response_format.
    delete body.response_format;
    res = await post(body, key, timeoutMs);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    const err = new Error(`Perplexity API ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return { text: extractText(data), results: extractResults(data), raw: data };
}
