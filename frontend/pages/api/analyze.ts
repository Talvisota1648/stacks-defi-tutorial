import type { NextApiRequest, NextApiResponse } from 'next'
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  return res.status(410).json({ error: 'Ручной анализ перенесён на /manual. Войдите в систему и выберите локальную модель или OpenRouter.' })
}
