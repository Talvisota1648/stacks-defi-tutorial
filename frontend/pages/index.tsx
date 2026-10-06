import Head from 'next/head'
import { useEffect, useRef, useState } from 'react'

type Finding = { category: string; timestamp: number; description: string; identifier?: string; confidence: string }
type Result = { summary: string; findings: Finding[] }
const categories = ['Автомобили и парковка', 'Самокаты', 'Свалки и отходы', 'Строения и ограждения']
const MAX_SIZE = 250 * 1024 * 1024

async function extractFrames(video: HTMLVideoElement, onProgress: (n: number) => void) {
  const canvas = document.createElement('canvas')
  const width = Math.min(1280, video.videoWidth)
  canvas.width = width
  canvas.height = Math.round(video.videoHeight * width / video.videoWidth)
  const ctx = canvas.getContext('2d')!
  const frames: { timestamp: number; image: string }[] = []
  const count = 12
  for (let i = 0; i < count; i++) {
    const timestamp = Math.max(0, Math.min(video.duration - 0.01, video.duration * (i + 0.5) / count))
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { clean(); reject(new Error('Не удалось прочитать кадр видео. Попробуйте MP4 с кодеком H.264.')) }, 10000)
      const clean = () => { window.clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', fail) }
      const done = () => { clean(); resolve() }
      const fail = () => { clean(); reject(new Error('Ошибка чтения видео.')) }
      video.addEventListener('seeked', done)
      video.addEventListener('error', fail)
      video.currentTime = timestamp
    })
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    frames.push({ timestamp: Math.round(timestamp * 10) / 10, image: canvas.toDataURL('image/jpeg', 0.75) })
    onProgress(Math.round((i + 1) / count * 45))
  }
  return frames
}
const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [ready, setReady] = useState(false)
  const [duration, setDuration] = useState(0)
  const [selected, setSelected] = useState(categories)
  const [location, setLocation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<Result | null>(null)
  const [reportMeta, setReportMeta] = useState<{ location: string; categories: string[] } | null>(null)
  const [drag, setDrag] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const serial = useRef(0)
  useEffect(() => { fetch('/api/analyze').then(r => r.json()).then(data => setConnected(data.configured === true)).catch(() => setConnected(false)) }, [])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  function choose(candidate?: File) {
    if (!candidate || busy) return
    setError('')
    if (!/\.(mp4|mov|webm)$/i.test(candidate.name)) { setError('Выберите видео в формате MP4, MOV или WebM.'); return }
    if (candidate.size > MAX_SIZE || candidate.size === 0) { setError('Размер видео должен быть от 1 байта до 250 МБ.'); return }
    serial.current++
    setFile(candidate); setUrl(URL.createObjectURL(candidate)); setReady(false); setDuration(0); setResult(null); setProgress(0)
  }
  async function analyze() {
    if (!video.current || !ready || busy || !selected.length) return
    const request = serial.current
    setBusy(true); setError(''); setResult(null); setProgress(0)
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 150000)
    try {
      video.current.pause()
      const frames = await extractFrames(video.current, setProgress)
      setProgress(55)
      const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frames, categories: selected, location, duration }), signal: controller.signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Не удалось выполнить анализ.')
      if (request === serial.current) { setResult(data); setReportMeta({ location, categories: [...selected] }); setProgress(100) }
    } catch (e) { setError(e instanceof Error && e.name === 'AbortError' ? 'Время ожидания истекло. Попробуйте ещё раз.' : e instanceof Error ? e.message : 'Ошибка анализа.') }
    finally { window.clearTimeout(timer); setBusy(false) }
  }
  function exportReport() {
    const blob = new Blob([JSON.stringify({ file: file?.name, location: reportMeta?.location || null, duration, categories: reportMeta?.categories, sampledFrames: 12, ...result }, null, 2)], { type: 'application/json' })
    const link = document.createElement('a'); const objectUrl = URL.createObjectURL(blob)
    link.href = objectUrl; link.download = 'osc-report.json'; link.click(); URL.revokeObjectURL(objectUrl)
  }
  return <>
    <Head><title>ОСЦ — Анализ видео</title><meta name="description" content="Загрузка видео и поиск признаков нарушений с помощью ИИ" /></Head>
    <div className="workspace-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="ОСЦ — главная"><span className="brand-symbol">◈</span> ОСЦ<span className="brand-version">MVP</span></a>
        <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <div className="nav-active"><span>▣</span> Анализ видео <span className="nav-dot" /></div>
        <div className="sidebar-note"><span className="tiny-dot" /> Видеоаналитика<br /><p>Первичное обнаружение признаков нарушений</p></div>
      </aside>
      <div className="workspace-main">
        <header className="topbar"><span>Рабочее пространство <span className="breadcrumb">/</span> <strong>Анализ видео</strong></span><span className="mode-pill"><span className="tiny-dot" /> {connected === null ? 'Проверка подключения' : connected ? 'ИИ настроен' : 'ИИ не подключён'}</span></header>
        <main className="content">
          <div className="page-heading"><div><div className="eyebrow">ВИДЕОАНАЛИТИКА</div><h1>От видео — к фактам</h1><p>Загрузите запись, чтобы найти признаки нарушений<br className="desktop-break" /> и собрать их в одном отчёте.</p></div><div className="private-badge">◈ <span>Ваше видео<br /><strong>под вашим контролем</strong></span></div></div>
          <div className="steps"><span className="step-current"><b>1</b> Загрузка видео</span><i /><span className={busy || result ? 'step-current' : ''}><b>2</b> ИИ-анализ</span><i /><span className={result ? 'step-current' : ''}><b>3</b> Результаты</span></div>
          <div className="analysis-grid">
            <section className="panel upload-panel"><div className="panel-heading"><h2><span className="heading-icon">↥</span> Материалы для анализа</h2><span className="small-label">01</span></div>
              {!file ? <div className={`dropzone ${drag ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files[0]) }}>
                <div className="upload-symbol">↥</div><h3>Перетащите видео сюда</h3><p>или выберите файл на устройстве</p><button className="secondary-button" onClick={() => input.current?.click()}>Выбрать видео <span>＋</span></button><span className="file-hint">MP4, MOV, WebM · до 250 МБ</span>
              </div> : <div className="video-area"><video ref={video} src={url} controls={!busy} preload="metadata" onLoadedMetadata={() => { const d = video.current?.duration || 0; if (!Number.isFinite(d) || d < 0.1) { setError('Видео должно быть длиннее 0,1 секунды и иметь определённую длительность.'); return } setDuration(d); setReady(true) }} onError={() => { setReady(false); setError('Браузер не может прочитать видео. Используйте MP4 с кодеком H.264.') }} /><div className="file-row"><div><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} МБ · {duration ? time(duration) : 'Чтение видео…'}</span></div><button disabled={busy} onClick={() => input.current?.click()} className="text-button">Заменить</button></div></div>}
              <input ref={input} type="file" accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" className="sr-only" aria-label="Выбрать видео" disabled={busy} onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
              <div className="location-field"><label htmlFor="location">Место съёмки <span>необязательно</span></label><input id="location" value={location} disabled={busy} maxLength={300} onChange={e => setLocation(e.target.value)} placeholder="Адрес или координаты места съёмки" /><p>Указанное место попадёт в отчёт. Геолокация автоматически не определяется.</p></div>
            </section>
            <section className="panel settings-panel"><div className="panel-heading"><h2><span className="heading-icon">⌕</span> Что искать</h2><span className="small-label">02</span></div><p className="panel-intro">Выберите категории для проверки</p><div className="category-list">{categories.map((category, index) => <label key={category} className={`category ${selected.includes(category) ? 'checked' : ''}`}><input type="checkbox" checked={selected.includes(category)} disabled={busy} onChange={() => setSelected(current => current.includes(category) ? current.filter(c => c !== category) : [...current, category])} /><span className="category-symbol">{['▰', '⌁', '♧', '▥'][index]}</span><span><strong>{category}</strong><small>{['Номера ТС, признаки нарушений парковки', 'Маркировка, пассажиры, парковка', 'Скопления мусора, эпизоды сброса', 'Постройки, заборы, перекрытие доступа'][index]}</small></span></label>)}</div><div className="analysis-note"><span>✦</span><p>12 кадров отправляются в OpenRouter. Оригинал видео остаётся на устройстве. События между кадрами могут быть пропущены.</p></div><button className="primary-button" onClick={analyze} disabled={!ready || busy || !selected.length || connected !== true}>{busy ? 'Анализируем видео…' : 'Начать анализ'} <span>{busy ? '◌' : '→'}</span></button>{busy && <div className="progress" role="status"><div><span>{progress < 50 ? 'Подготовка кадров' : 'Поиск признаков нарушений'}</span><span>{progress}%</span></div><progress max={100} value={progress} /></div>}{connected === false && <p className="connection-note">Для анализа необходимо подключить ИИ-модель на сервере.</p>}</section>
          </div>
          {error && <div className="error-message" role="alert">{error}</div>}
          <section className="panel results-panel"><div className="panel-heading"><h2><span className="heading-icon">☷</span> Результаты анализа {result && <span className="count-badge">{result.findings.length}</span>}</h2>{result ? <button onClick={exportReport} className="text-button">Скачать отчёт ↓</button> : <span className="waiting-label">ОЖИДАНИЕ ВИДЕО</span>}</div>
            {!result ? <div className="empty-results"><div className="empty-symbol">⌕</div><div><h3>Здесь появятся найденные признаки</h3><p>Временные отметки, описание события и распознанные номера —<br className="desktop-break" /> всё для дальнейшей проверки оператором.</p></div></div> : <div className="results-body"><p className="result-summary">{result.summary}</p>{!result.findings.length && <p>В выбранных кадрах признаки не обнаружены. Это не исключает события в остальной записи.</p>}{result.findings.map((finding, index) => <article className="finding" key={index}><button className="timestamp" onClick={() => { if (video.current) { video.current.currentTime = finding.timestamp; video.current.scrollIntoView({ behavior: 'smooth', block: 'center' }) } }}>{time(finding.timestamp)} ↗</button><div><span className="finding-category">{finding.category}</span><p>{finding.description}</p>{finding.identifier && <span className="identifier">Номер / ID: {finding.identifier}</span>}</div><span className="confidence">Уверенность: {finding.confidence}</span></article>)}</div>}
          </section>
          <footer className="page-footer"><span>ⓘ Результат ИИ — основание для проверки, а не юридическое заключение.</span><span>ОСЦ · Анализ видео</span></footer>
        </main>
      </div>
    </div>
  </>
}
