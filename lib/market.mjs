// Market data from Yahoo Finance's public chart endpoint (no key needed).
// Symbols use Yahoo format: AAPL, AZN.L (London), BT-A.L, SAP.DE, MC.PA, BTC-USD.
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function getJSON(path) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + path, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheRecap/1.0)', Accept: 'application/json' },
      });
      if (r.ok) return await r.json();
      lastErr = new Error(`Yahoo ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function chart(symbol, { range = '1mo', interval = '1d' } = {}) {
  const j = await getJSON(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`No chart data for ${symbol}`);
  const meta = res.meta || {};
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const points = ts.map((t, i) => ({ t: t * 1000, c: closes[i] })).filter((p) => typeof p.c === 'number');
  return {
    symbol: meta.symbol || symbol,
    currency: meta.currency || '',
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    name: meta.longName || meta.shortName || '',
    price: meta.regularMarketPrice,
    prevClose: meta.chartPreviousClose ?? meta.previousClose,
    marketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
    points,
  };
}

// Live quote plus today's intraday line.
export async function quote(symbol) {
  const c = await chart(symbol, { range: '1d', interval: '5m' });
  const change = c.price != null && c.prevClose ? ((c.price / c.prevClose) - 1) * 100 : null;
  return {
    symbol: c.symbol, name: c.name, exchange: c.exchange, currency: c.currency,
    price: c.price, prevClose: c.prevClose, change, marketTime: c.marketTime,
    intraday: c.points.map((p) => +p.c.toFixed(4)),
  };
}

export async function quotes(symbols) {
  const uniq = [...new Set(symbols.filter(Boolean).map(String))].slice(0, 12);
  const settled = await Promise.allSettled(uniq.map((s) => quote(s)));
  const out = {};
  settled.forEach((r, i) => { out[uniq[i]] = r.status === 'fulfilled' ? r.value : { symbol: uniq[i], error: true }; });
  return out;
}

// Daily closes around a news date: up to 5 sessions before and 5 after.
export async function eventWindow(symbol, isoDate) {
  const c = await chart(symbol, { range: '1mo', interval: '1d' });
  if (!c.points.length) throw new Error(`No closes for ${symbol}`);
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  // b = last close strictly before the news date ("before the news").
  // The news day is b + 1; it may not exist yet if that session hasn't closed.
  let b = -1;
  c.points.forEach((p, i) => { if (day(p.t) < isoDate) b = i; });
  if (b < 0) throw new Error(`No close before ${isoDate} for ${symbol}`);
  const from = Math.max(0, b - 4);
  const to = Math.min(c.points.length - 1, b + 6);
  const slice = c.points.slice(from, to + 1);
  return {
    series: slice.map((p) => +p.c.toFixed(4)),
    dates: slice.map((p) => day(p.t)),
    eventIndex: b + 1 - from,
    currency: c.currency,
    exchange: c.exchange,
  };
}
