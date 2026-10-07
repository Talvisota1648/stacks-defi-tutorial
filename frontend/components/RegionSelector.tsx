import { ReactNode, useRef } from 'react'
import type { Region } from '../lib/analysis'

export default function RegionSelector({ children, region, onChange, editing, width, height }: { children: ReactNode; region?: Region; onChange: (region?: Region) => void; editing: boolean; width: number; height: number }) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) }
  }
  return <div className="media-stage" style={{ width: width && height ? 320 * width / height : undefined }}>
    {children}
    {editing && <div className="selection-surface" aria-label="Выделите область номера мышью или пальцем" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); start.current = point(e); onChange(undefined) }} onPointerMove={e => {
      if (!start.current) return
      const end = point(e), begin = start.current
      onChange({ x: Math.min(begin.x, end.x), y: Math.min(begin.y, end.y), width: Math.abs(end.x - begin.x), height: Math.abs(end.y - begin.y) })
    }} onPointerUp={e => { start.current = null; e.currentTarget.releasePointerCapture(e.pointerId); if (!region || region.width * width < 12 || region.height * height < 8) onChange(undefined) }} onPointerCancel={() => { start.current = null; onChange(undefined) }} />}
    {region && <div className="selection-box" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />}
  </div>
}
