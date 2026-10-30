// GET /api/quote?s=AZN.L,NWG.L  -> live price, day change and intraday line per symbol.
import { quotes } from '../lib/market.mjs';

export default async function handler(req, res) {
  const raw = String(req.query?.s || '').trim();
  const symbols = raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.\-^=]{1,16}$/.test(s));
  if (!symbols.length) return res.status(400).json({ error: 'Pass ?s=SYMBOL[,SYMBOL]' });
  try {
    const data = await quotes(symbols);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Market data unavailable' });
  }
}
