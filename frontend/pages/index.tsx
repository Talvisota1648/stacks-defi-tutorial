import Head from 'next/head'
import { useEffect, useRef, useState } from 'react'
import RegionSelector from '../components/RegionSelector'
import { categories, Frame, Region, Result } from '../lib/analysis'
import { extractFrames, makeFrame } from '../lib/media'

const MAX_VIDEO_SIZE = 250 * 1024 * 1024, MAX_PHOTO_SIZE = 20 * 1024 * 1024
const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
const plateStatus = { agreement: 'Совпадение на нескольких кадрах — проверьте вырезки', single: 'Одно прочтение / неопределённость — требуется проверка', conflict: 'Прочтения расходятся — номер не подтверждён', unreadable: 'Номер не прочитан' }

export default function Home() {
  const [file, setFile] = useState<File | null>(null), [url, setUrl] = useState(''), [mediaType, setMediaType] = useState<'video' | 'photo'>('video')
  const [ready, setReady] = useState(false), [duration, setDuration] = useState(0), [size, setSize] = useState({ width: 0, height: 0 })
  const [selected, setSelected] = useState(categories), [location, setLocation] = useState(''), [error, setError] = useState('')
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [result, setResult] = useState<Result | null>(null)
  const [reportMeta, setReportMeta] = useState<{ location: string; categories: string[]; region?: Region } | null>(null)
  const [frames, setFrames] = useState<Frame[]>([]), [region, setRegion] = useState<Region>(), [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState(false), [connected, setConnected] = useState<boolean | null>(null)
  const video = useRef<HTMLVideoElement>(null), photo = useRef<HTMLImageElement>(null), input = useRef<HTMLInputElement>(null)
  useEffect(() => { fetch('/api/analyze').then(r => r.json()).then(data => setConnected(data.configured === true)).catch(() => setConnected(false)) }, [])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  function choose(candidate?: File) {
    if (!candidate || busy) return
    setError('')
    const isPhoto = /\.(jpe?g|png|webp)$/i.test(candidate.name)
    if (!isPhoto && !/\.(mp4|mov|webm)$/i.test(candidate.name)) { setError('Выберите видео MP4/MOV/WebM или фото JPG/PNG/WebP.'); return }
    const limit = isPhoto ? MAX_PHOTO_SIZE : MAX_VIDEO_SIZE
    if (!candidate.size || candidate.size > limit) { setError(`Файл должен быть непустым и не больше ${isPhoto ? 20 : 250} МБ.`); return }
    setFile(candidate); setMediaType(isPhoto ? 'photo' : 'video'); setUrl(URL.createObjectURL(candidate)); setReady(false); setDuration(0); setSize({ width: 0, height: 0 }); setResult(null); setFrames([]); setRegion(undefined); setEditing(false); setProgress(0)
  }
  async function analyze() {
    if (!ready || busy || editing || !selected.length) return
    setBusy(true); setError(''); setResult(null); setFrames([]); setProgress(0)
    const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 180000)
    try {
      let prepared: Frame[]
      if (mediaType === 'photo') {
        if (!photo.current) throw new Error('Фото ещё не загружено.')
        prepared = [makeFrame(photo.current, size.width, size.height, 's0', 0)]
        if (region) prepared.push(makeFrame(photo.current, size.width, size.height, 'p0', 0, region))
      } else {
        if (!video.current) throw new Error('Видео ещё не загружено.')
        prepared = await extractFrames(video.current, setProgress, region)
      }
      setFrames(prepared); setProgress(55)
      const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType, frames: prepared, categories: selected, location, duration }), signal: controller.signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Не удалось выполнить анализ.')
      setResult(data); setReportMeta({ location, categories: [...selected], region }); setProgress(100)
    } catch (e) { setError(e instanceof Error && e.name === 'AbortError' ? 'Время ожидания истекло. Попробуйте ещё раз.' : e instanceof Error ? e.message : 'Ошибка анализа.') }
    finally { window.clearTimeout(timer); setBusy(false) }
  }
  function exportReport() {
    const blob = new Blob([JSON.stringify({ file: file?.name, mediaType, location: reportMeta?.location || null, duration, categories: reportMeta?.categories, region: reportMeta?.region || null, sampledFrames: frames.filter(f => f.kind === 'scene').length, images: frames, comparisonNote: 'Прочтения получены в одном запросе одной модели; совпадение не доказывает правильность. Проверяйте вырезки.', ...result }, null, 2)], { type: 'application/json' })
    const link = document.createElement('a'), objectUrl = URL.createObjectURL(blob)
    link.href = objectUrl; link.download = 'osc-report.json'; link.click(); URL.revokeObjectURL(objectUrl)
  }
  function jump(timestamp: number) { if (video.current) { video.current.currentTime = timestamp; video.current.scrollIntoView({ behavior: 'smooth', block: 'center' }) } }
  return <>
    <Head><title>ОСЦ — Анализ видео и фото</title><meta name="description" content="Поиск визуальных признаков нарушений и чтение российских номеров" /></Head>
    <div className="workspace-shell"><aside className="sidebar">
      <a className="brand" href="/" aria-label="ОСЦ — главная"><span className="brand-symbol">◈</span> ОСЦ<span className="brand-version">MVP</span></a>
      <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div><div className="nav-active"><span>▣</span> Видео и фото <span className="nav-dot" /></div>
      <div className="sidebar-note"><span className="tiny-dot" /> Визуальный анализ<p>Первичное обнаружение признаков нарушений</p></div>
    </aside><div className="workspace-main">
      <header className="topbar"><span>Рабочее пространство <span className="breadcrumb">/</span> <strong>Видео и фото</strong></span><span className="mode-pill"><span className="tiny-dot" /> {connected === null ? 'Проверка подключения' : connected ? 'ИИ настроен' : 'ИИ не подключён'}</span></header>
      <main className="content"><div className="page-heading"><div><div className="eyebrow">ВИЗУАЛЬНЫЙ АНАЛИЗ</div><h1>От съёмки — к фактам</h1><p>Загрузите видео или фото. Признаки нарушений и прочтения<br className="desktop-break" /> номеров появятся в отдельных разделах отчёта.</p></div><div className="private-badge">◈ <span>Ваши материалы<br /><strong>под вашим контролем</strong></span></div></div>
      <div className="steps"><span className="step-current"><b>1</b> Материалы</span><i /><span className={busy || result ? 'step-current' : ''}><b>2</b> ИИ-анализ</span><i /><span className={result ? 'step-current' : ''}><b>3</b> Результаты</span></div>
      <div className="analysis-grid"><section className="panel upload-panel"><div className="panel-heading"><h2><span className="heading-icon">↥</span> Материалы для анализа</h2><span className="small-label">01</span></div>
        {!file ? <div className={`dropzone ${drag ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files[0]) }}><div className="upload-symbol">↥</div><h3>Перетащите видео или фото сюда</h3><p>или выберите файл на устройстве</p><button className="secondary-button" onClick={() => input.current?.click()}>Выбрать файл <span>＋</span></button><span className="file-hint">MP4 / MOV / WebM · до 250 МБ<br />JPG / PNG / WebP · до 20 МБ</span></div> : <div className="video-area">
          <RegionSelector region={region} onChange={setRegion} editing={editing} width={size.width} height={size.height}>
          {mediaType === 'video' ? <video key={url} ref={video} src={url} controls={!busy && !editing} preload="metadata" onLoadedMetadata={() => { const v = video.current!; if (!Number.isFinite(v.duration) || v.duration < 0.1) { setError('Видео должно быть длиннее 0,1 секунды.'); return } setDuration(v.duration); setSize({ width: v.videoWidth, height: v.videoHeight }); setReady(true) }} onError={() => { setReady(false); setError('Браузер не может прочитать видео. Используйте MP4/H.264.') }} /> : <img key={url} ref={photo} src={url} alt="Загруженное фото" onLoad={() => { const p = photo.current!; if (p.naturalWidth * p.naturalHeight > 40000000) { setError('Фото больше 40 мегапикселей. Уменьшите его перед загрузкой.'); return } setSize({ width: p.naturalWidth, height: p.naturalHeight }); setReady(true) }} onError={() => { setReady(false); setError('Не удалось прочитать фото.'); }} />}
          </RegionSelector>
          <div className="file-row"><div><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} МБ · {mediaType === 'photo' ? `${size.width}×${size.height} px` : duration ? time(duration) : 'Чтение видео…'}</span></div><button disabled={busy} onClick={() => input.current?.click()} className="text-button">Заменить</button></div>
          {ready && selected.includes(categories[0]) && <div className="region-controls"><button className="secondary-button" disabled={busy} onClick={() => { video.current?.pause(); setEditing(!editing) }}>{editing ? 'Готово' : region ? 'Изменить область номера' : 'Выделить область номера'}</button>{region && <button className="text-button" disabled={busy} onClick={() => { setRegion(undefined); setEditing(false) }}>Убрать область</button>}<p>{editing ? 'Обведите номер на изображении мышью или пальцем и нажмите «Готово».' : 'Для точного чтения выделите номер с небольшим запасом. В видео рамка неподвижна: проверяйте, что в неё попадает тот же автомобиль на разных моментах.'}</p>{region && <p>Вырезка в исходном разрешении: {Math.round(region.width * size.width)}×{Math.round(region.height * size.height)} px</p>}</div>}
        </div>}
        <input ref={input} type="file" accept=".mp4,.mov,.webm,.jpg,.jpeg,.png,.webp" className="sr-only" aria-label="Выбрать видео или фото" disabled={busy} onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
        <div className="location-field"><label htmlFor="location">Место съёмки <span>необязательно</span></label><input id="location" value={location} disabled={busy} maxLength={300} onChange={e => setLocation(e.target.value)} placeholder="Адрес или координаты места съёмки" /><p>Место вводится вручную. Автоматическая геолокация не выполняется.</p></div>
      </section><section className="panel settings-panel"><div className="panel-heading"><h2><span className="heading-icon">⌕</span> Что искать</h2><span className="small-label">02</span></div><p className="panel-intro">Выберите категории для проверки</p><div className="category-list">{categories.map((category, index) => <label key={category} className={`category ${selected.includes(category) ? 'checked' : ''}`}><input type="checkbox" checked={selected.includes(category)} disabled={busy} onChange={() => { if (index === 0) { setRegion(undefined); setEditing(false) } setSelected(current => current.includes(category) ? current.filter(c => c !== category) : [...current, category]) }} /><span className="category-symbol">{['▰', '⌁', '♧', '▥'][index]}</span><span><strong>{category}</strong><small>{['Российские номера, признаки нарушений', 'Маркировка, пассажиры, парковка', 'Скопления мусора, эпизоды сброса', 'Постройки, заборы, перекрытие доступа'][index]}</small></span></label>)}</div>
        <div className="analysis-note"><span>✦</span><p>{mediaType === 'photo' ? region ? 'В OpenRouter отправятся общий снимок и вырезка номера.' : 'В OpenRouter отправится один снимок.' : region ? 'Локально проверяем резкость 24 кадров. Отправляем 6 общих кадров и 6 вырезок номера в одном запросе.' : 'В OpenRouter отправятся 12 общих кадров. Для чтения мелких номеров выделите область.'} Оригинальный файл не сохраняется на сервере. Стоимость зависит от токенов изображений; события между кадрами могут быть пропущены.</p></div>
        <button className="primary-button" onClick={analyze} disabled={!ready || busy || editing || !selected.length || connected !== true}>{busy ? 'Анализируем…' : 'Начать анализ'} <span>{busy ? '◌' : '→'}</span></button>{busy && <div className="progress" role="status"><div><span>{progress < 50 ? 'Подготовка и выбор кадров' : 'Чтение номеров и анализ сцены'}</span><span>{progress}%</span></div><progress max={100} value={progress} /></div>}{connected === false && <p className="connection-note">Для анализа необходимо подключить ИИ-модель на сервере.</p>}
      </section></div>
      {error && <div className="error-message" role="alert">{error}</div>}
      <section className="panel results-panel"><div className="panel-heading"><h2><span className="heading-icon">☷</span> Признаки нарушений {result && <span className="count-badge">{result.findings.length}</span>}</h2>{result ? <button onClick={exportReport} className="text-button">Скачать отчёт ↓</button> : <span className="waiting-label">ОЖИДАНИЕ МАТЕРИАЛОВ</span>}</div>
        {!result ? <div className="empty-results"><div className="empty-symbol">⌕</div><div><h3>Здесь появятся признаки для проверки</h3><p>Обычное движение и перевозка повреждённой машины<br className="desktop-break" /> сами по себе не являются нарушениями.</p></div></div> : <div className="results-body"><p className="result-summary">{result.summary}</p>{!result.findings.length && <p>В переданных изображениях признаки нарушений не обнаружены.{mediaType === 'video' && ' Это не исключает события между выбранными кадрами.'}</p>}{result.findings.map(finding => <article className="finding" key={`${finding.category}:${finding.eventId}`}><button className="timestamp" disabled={mediaType === 'photo'} onClick={() => jump(finding.timestamp)}>{mediaType === 'photo' ? 'Фото' : `${time(finding.timestamp)} ↗`}</button><div><span className="finding-category">{finding.category}</span><p style={{ whiteSpace: 'pre-line' }}>{finding.description}</p><small>Кадры-основания: {finding.evidence.join(', ')}</small></div><span className="confidence">Уверенность: {finding.confidence}</span></article>)}</div>}
      </section>
      {result && <section className="panel results-panel"><div className="panel-heading"><h2>Распознавание российских номеров <span className="count-badge">{result.plates.length}</span></h2></div><p className="plate-disclaimer">Это отдельные наблюдения, а не нарушения. Совпадение ответов одной модели не подтверждает правильность номера: проверяйте изображения. Поддерживается стандартный формат А123ВС77 / А123ВС777.</p>{!result.plates.length && <p className="plate-disclaimer">Читаемые номерные знаки не обнаружены. Попробуйте выделить область номера.</p>}{result.plates.map(plate => <article className="plate-result" key={plate.vehicleId}><div className="plate-title"><strong className="identifier">{plate.number || 'Номер не подтверждён'}</strong><span>{plateStatus[plate.status]}</span></div>{plate.alternatives.length > 0 && <p className="plate-disclaimer">Варианты: {plate.alternatives.join(' / ')}</p>}<div className="reading-grid">{plate.readings.map(reading => { const frame = frames.find(f => f.id === reading.imageId); return frame && <figure key={reading.imageId}><img src={frame.image} alt={`Изображение ${frame.id}: ${reading.number || 'номер не прочитан'}`} /><figcaption><button className="text-button" disabled={mediaType === 'photo'} onClick={() => jump(frame.timestamp)}>{mediaType === 'photo' ? 'Фото' : time(frame.timestamp)} · {frame.id}</button><strong>{reading.number || 'Не прочитан'}</strong><span>{reading.readability === 'readable' ? 'Прочтение модели' : reading.readability === 'uncertain' ? 'Неуверенное прочтение' : 'Нечитаемо / неверный формат'}</span><small>{frame.width}×{frame.height} px</small></figcaption></figure> })}</div></article>)}</section>}
      <footer className="page-footer"><span>ⓘ Результат ИИ — основание для проверки, а не юридическое заключение.</span><span>ОСЦ · Видео и фото</span></footer>
      </main></div></div>
  </>
}
