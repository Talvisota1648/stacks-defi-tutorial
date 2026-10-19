import type { NextApiRequest, NextApiResponse } from 'next'
import http from 'http'
import https from 'https'
export const config = { api: { bodyParser: false, responseLimit: false } }
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const parts = req.query.path
  if (!Array.isArray(parts) || parts.some(p => !p || p === '..' || p.includes('/') || p.includes('\\'))) return res.status(400).json({ detail: 'Некорректный путь' })
  const base = new URL(process.env.OSC_BACKEND_URL || 'http://127.0.0.1:8000')
  const target = new URL(`/api/v2/${parts.map(encodeURIComponent).join('/')}`, base)
  for (const [key, value] of Object.entries(req.query)) if (key !== 'path' && typeof value === 'string') target.searchParams.set(key, value)
  const headers: Record<string, string> = {}
  for (const key of ['authorization', 'content-type', 'content-length', 'range']) if (typeof req.headers[key] === 'string') headers[key] = req.headers[key] as string
  const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => {
    res.statusCode = response.statusCode || 502
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'x-content-sha256']) if (response.headers[key]) res.setHeader(key, response.headers[key]!)
    res.setHeader('Cache-Control', 'no-store')
    response.pipe(res)
  })
  upstream.setTimeout(300000, () => upstream.destroy(new Error('Backend timeout')))
  upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ detail: 'Сервис камер недоступен. Запустите backend API.' }); else res.destroy() })
  req.on('aborted', () => upstream.destroy())
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}
