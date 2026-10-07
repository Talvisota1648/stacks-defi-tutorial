import type { Frame, Region } from './analysis'

function canvasFor(width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  return canvas
}
export function makeFrame(source: CanvasImageSource, width: number, height: number, id: string, timestamp: number, region?: Region): Frame {
  const crop = region ? { x: Math.round(region.x * width), y: Math.round(region.y * height), width: Math.max(1, Math.round(region.width * width)), height: Math.max(1, Math.round(region.height * height)) } : null
  const scale = crop ? 1 : Math.min(1, 1280 / Math.max(width, height))
  const canvas = canvasFor(crop ? crop.width : Math.max(1, Math.round(width * scale)), crop ? crop.height : Math.max(1, Math.round(height * scale)))
  const ctx = canvas.getContext('2d')!
  if (crop) ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
  else ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  const image = canvas.toDataURL('image/jpeg', crop ? 0.98 : 0.8)
  if (image.length > 2000000 || canvas.width * canvas.height > 16000000) throw new Error('Выделенная область слишком большая. Выделите только номер с небольшим запасом.')
  return { id, timestamp, image, kind: crop ? 'plate' : 'scene', width: canvas.width, height: canvas.height }
}
async function seek(video: HTMLVideoElement, timestamp: number) {
  if (Math.abs(video.currentTime - timestamp) < 0.0001 && video.readyState >= 2) return
  await new Promise<void>((resolve, reject) => {
    const clean = () => { window.clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', fail) }
    const done = () => { clean(); resolve() }
    const fail = () => { clean(); reject(new Error('Не удалось прочитать кадр видео. Используйте MP4/H.264.')) }
    const timer = window.setTimeout(fail, 10000)
    video.addEventListener('seeked', done); video.addEventListener('error', fail); video.currentTime = timestamp
  })
}
// Local sharpness heuristic, not a plate detector. Scores a fixed user-selected area only.
function sharpness(video: HTMLVideoElement, region: Region) {
  const width = Math.max(1, Math.round(region.width * video.videoWidth)), height = Math.max(1, Math.round(region.height * video.videoHeight))
  const scale = Math.min(1, 256 / width)
  const canvas = canvasFor(Math.max(3, Math.round(width * scale)), Math.max(3, Math.round(height * scale)))
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, region.x * video.videoWidth, region.y * video.videoHeight, width, height, 0, 0, canvas.width, canvas.height)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const gray = (i: number) => (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3
  let sum = 0, squares = 0, count = 0
  for (let y = 1; y < canvas.height - 1; y++) for (let x = 1; x < canvas.width - 1; x++) {
    const i = y * canvas.width + x
    const lap = gray(i - 1) + gray(i + 1) + gray(i - canvas.width) + gray(i + canvas.width) - 4 * gray(i)
    sum += lap; squares += lap * lap; count++
  }
  return count ? squares / count - (sum / count) ** 2 : 0
}
export async function extractFrames(video: HTMLVideoElement, onProgress: (n: number) => void, region?: Region): Promise<Frame[]> {
  const frames: Frame[] = []
  video.pause()
  const bins = region ? 6 : 12
  const candidates = region ? 4 : 1
  for (let bin = 0; bin < bins; bin++) {
    let bestScore = -1, bestTime = 0
    for (let candidate = 0; candidate < candidates; candidate++) {
      const timestamp = Math.max(0, Math.min(video.duration - 0.001, video.duration * (bin + (candidate + 0.5) / candidates) / bins))
      await seek(video, timestamp)
      const score = region ? sharpness(video, region) : 0
      if (score > bestScore) { bestScore = score; bestTime = timestamp }
      onProgress(Math.round((bin * candidates + candidate + 1) / (bins * candidates) * 45))
    }
    await seek(video, bestTime)
    const timestamp = Math.min(video.duration, Math.round(bestTime * 1000) / 1000)
    frames.push(makeFrame(video, video.videoWidth, video.videoHeight, `s${bin}`, timestamp))
    if (region) frames.push(makeFrame(video, video.videoWidth, video.videoHeight, `p${bin}`, timestamp, region))
  }
  return frames
}
