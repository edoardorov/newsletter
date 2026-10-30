export const THEMES = ['Rates', 'Inflation', 'Labour market', 'Growth', 'Earnings', 'AI', 'Tech', 'Consumer', 'Telecom',
  'Energy', 'Commodities', 'FX', 'Geopolitics', 'Crypto', 'Regulation', 'M&A', 'Banking', 'Real estate', 'Private markets', 'Healthcare'];
export const REGIONS = ['UK', 'Europe', 'US', 'Global'];
export const ASSETS = ['Equities', 'Rates', 'FX', 'Commodities', 'Crypto', 'Alternatives'];
export const SENTIMENTS = ['Positive', 'Negative', 'Neutral'];
export const SCOPES = ['Macro', 'Micro'];

const pick = (v, list, dflt) => {
  const s = String(v || '').trim().toLowerCase();
  return list.find((x) => x.toLowerCase() === s) || dflt;
};
const num01 = (v, d = 0.5) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n > 1 ? n / 100 : n)) : d;
};

export function cleanStory(s, { stripCites = (x) => x } = {}) {
  const str = (v, max = 600) => stripCites(String(v || '')).slice(0, max);
  const themes = (Array.isArray(s.themes) ? s.themes : [])
    .map((t) => pick(t, THEMES, null)).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).slice(0, 3);
  const companies = (Array.isArray(s.companies) ? s.companies : [])
    .filter((c) => c && c.ticker && c.listed !== false)
    .slice(0, 4)
    .map((c) => {
      const move = Number(c.move);
      return {
        name: str(c.name, 80),
        ticker: String(c.ticker).trim().toUpperCase().slice(0, 16),
        move: Number.isFinite(move) ? Math.round(move * 10) / 10 : null,
      };
    });
  const body = (Array.isArray(s.body) ? s.body : [s.body]).map((p) => str(p, 1200)).filter(Boolean).slice(0, 4);
  return {
    scope: pick(s.scope, SCOPES, 'Micro'),
    region: pick(s.region, REGIONS, 'Global'),
    asset: pick(s.asset, ASSETS, 'Equities'),
    sentiment: pick(s.sentiment, SENTIMENTS, 'Neutral'),
    themes: themes.length ? themes : ['Growth'],
    keywords: (Array.isArray(s.keywords) ? s.keywords : []).map((k) => str(k, 40)).filter(Boolean).slice(0, 5),
    companies,
    cov: num01(s.coverage ?? s.cov),
    imp: num01(s.impact ?? s.imp),
    title: str(s.title, 200),
    dek: str(s.dek, 260),
    body,
  };
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'story';
}
