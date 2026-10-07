export const categories = ['Автомобили и парковка', 'Самокаты', 'Свалки и отходы', 'Строения и ограждения']
export type Region = { x: number; y: number; width: number; height: number }
export type Frame = { id: string; timestamp: number; image: string; kind: 'scene' | 'plate'; width: number; height: number }
export type Input = { mediaType: 'video' | 'photo'; frames: Frame[]; categories: string[]; location: string; duration: number }
export type Reading = { imageId: string; vehicleId: string; number: string; readability: 'readable' | 'uncertain' | 'unreadable' }
export type Plate = { vehicleId: string; number: string; status: 'agreement' | 'single' | 'conflict' | 'unreadable'; alternatives: string[]; readings: Reading[] }
export type Finding = { category: string; eventId: string; timestamp: number; description: string; confidence: string; evidence: string[] }
export type Result = { summary: string; findings: Finding[]; plates: Plate[] }

export function normalizeRussianPlate(value: string): string {
  const latin: Record<string, string> = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х' }
  const normalized = value.toUpperCase().replace(/[\s-]/g, '').replace(/[ABEKMHOPCTYX]/g, c => latin[c])
  // Standard Russian private vehicle format only. Never turn a guessed digit into a letter.
  return /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/.test(normalized) ? normalized : ''
}
export function validInput(value: any): value is Input {
  if (!value || !['video', 'photo'].includes(value.mediaType) || !Array.isArray(value.frames) || !Array.isArray(value.categories) || !value.categories.length || value.categories.length > 4 || value.categories.some((c: unknown) => !categories.includes(c as string)) || typeof value.location !== 'string' || value.location.length > 300 || typeof value.duration !== 'number' || !Number.isFinite(value.duration) || (value.mediaType === 'video' ? value.duration < 0.1 : value.duration !== 0)) return false
  const frames: any[] = value.frames
  if (frames.length < 1 || frames.length > 12 || new Set(frames.map(f => f?.id)).size !== frames.length) return false
  if (value.mediaType === 'photo' && (frames.filter(f => f?.kind === 'scene').length !== 1 || frames.filter(f => f?.kind === 'plate').length > 1)) return false
  if (frames.some(f => !f || typeof f.id !== 'string' || !/^[sp]\d{1,2}$/.test(f.id) || !['scene', 'plate'].includes(f.kind) || !f.id.startsWith(f.kind === 'scene' ? 's' : 'p') || typeof f.timestamp !== 'number' || !Number.isFinite(f.timestamp) || f.timestamp < 0 || f.timestamp > value.duration || typeof f.image !== 'string' || f.image.length > 2000000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(f.image) || !Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < 1 || f.height < 1 || f.width * f.height > 16000000)) return false
  const scenes = frames.filter(f => f.kind === 'scene')
  if (!scenes.length || frames.some(f => f.kind === 'plate' && !scenes.some(s => s.timestamp === f.timestamp))) return false
  return true
}

export function processModelResult(raw: any, input: Input): Result {
  if (!raw || typeof raw.summary !== 'string' || raw.summary.length > 5000 || !Array.isArray(raw.findings) || raw.findings.length > 20 || !Array.isArray(raw.readings) || raw.readings.length > 60) throw new Error('Invalid model result')
  const sceneIds = new Set(input.frames.filter(f => f.kind === 'scene').map(f => f.id))
  const hasCrops = input.frames.some(f => f.kind === 'plate')
  const readingIds = new Set(input.frames.filter(f => !hasCrops || f.kind === 'plate').map(f => f.id))
  const ids = new Set<string>()
  const readings: Reading[] = raw.readings.map((r: any) => {
    if (!r || !readingIds.has(r.imageId) || typeof r.vehicleId !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(r.vehicleId) || typeof r.number !== 'string' || r.number.length > 100 || !['readable', 'uncertain', 'unreadable'].includes(r.readability)) throw new Error('Invalid reading')
    // A selected region represents one vehicle; context images cannot supply its number.
    const vehicleId = hasCrops ? 'selected-vehicle' : r.vehicleId
    const identity = `${r.imageId}:${vehicleId}`
    if (ids.has(identity)) throw new Error('Duplicate reading')
    ids.add(identity)
    const number = r.readability === 'unreadable' ? '' : normalizeRussianPlate(r.number)
    return { imageId: r.imageId, vehicleId, number, readability: number ? r.readability : 'unreadable' }
  })
  if (hasCrops) {
    // Missing observations remain explicitly unreadable rather than inheriting another frame's value.
    for (const id of Array.from(readingIds)) if (!readings.some(r => r.imageId === id)) readings.push({ imageId: id, vehicleId: 'selected-vehicle', number: '', readability: 'unreadable' })
  }
  const plates: Plate[] = Array.from(new Set(readings.map(r => r.vehicleId))).map(vehicleId => {
    const group = readings.filter(r => r.vehicleId === vehicleId)
    const alternatives = Array.from(new Set(group.filter(r => r.number).map(r => r.number)))
    const readable = group.filter(r => r.readability === 'readable' && r.number)
    const distinctImages = new Set(readable.map(r => input.frames.find(f => f.id === r.imageId)!.image)).size
    // Any competing valid reading forces review; frequency does not resolve contradictions.
    const status = alternatives.length > 1 ? 'conflict' : distinctImages >= 2 ? 'agreement' : alternatives.length ? 'single' : 'unreadable'
    return { vehicleId, number: status === 'agreement' || status === 'single' ? alternatives[0] : '', status, alternatives, readings: group }
  })
  const events = new Map<string, Finding>()
  for (const f of raw.findings) {
    if (!f || !input.categories.includes(f.category) || typeof f.eventId !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(f.eventId) || typeof f.description !== 'string' || f.description.length > 3000 || typeof f.observableEvidence !== 'string' || f.observableEvidence.length > 2000 || typeof f.requiresExternalVerification !== 'boolean' || !['низкая', 'средняя', 'высокая'].includes(f.confidence) || !Array.isArray(f.evidence) || !f.evidence.length || f.evidence.length > 12 || f.evidence.some((id: unknown) => !sceneIds.has(id as string)) || !['suspected_violation', 'ordinary_activity', 'insufficient_evidence'].includes(f.assessment) || !['parking', 'traffic', 'scooter', 'waste', 'construction', 'obstruction', 'other'].includes(f.eventType)) throw new Error('Invalid finding')
    // Ordinary activities are never counted as violations. Evidence is mandatory.
    if (f.assessment !== 'suspected_violation' || !f.observableEvidence.trim()) continue
    // Transporting a damaged car, without another concrete action, is not an offence.
    if (f.eventType === 'other') continue
    if (/(?:эвакуатор|перевоз|поврежд[её]н|разбит)/i.test(f.description) && !/(?:парков|стоян|стоит|сброс|выгруз|перекры|заблок|проезд на красн|встречн|сплошн)/i.test(f.observableEvidence)) continue
    const identity = `${f.category}:${f.eventId}`
    const evidence: string[] = Array.from(new Set<string>(f.evidence))
    const timestamp = Math.min(...input.frames.filter(frame => evidence.includes(frame.id)).map(frame => frame.timestamp))
    const existing = events.get(identity)
    if (existing) {
      existing.evidence = Array.from(new Set([...existing.evidence, ...evidence]))
      existing.timestamp = Math.min(existing.timestamp, timestamp)
    } else events.set(identity, { category: f.category, eventId: f.eventId, timestamp, description: `${f.description}\nНаблюдаемые признаки: ${f.observableEvidence}${f.requiresExternalVerification ? '\nТребуется проверка правил участка, документов или обстоятельств.' : ''}`, confidence: f.requiresExternalVerification ? 'низкая' : f.confidence, evidence })
  }
  return { summary: raw.summary, findings: Array.from(events.values()), plates }
}
