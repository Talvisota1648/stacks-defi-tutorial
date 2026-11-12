const { normalizeTask } = require('../lib/report-view.cjs')
import { AppShell } from '../components/Interface'
import Head from 'next/head'
import { useEffect, useRef, useState } from 'react'
import RegionSelector from '../components/RegionSelector'
import type { Region } from '../lib/analysis'

type ImageFrame = {
  id: string
  timestamp: number | null
  width: number
  height: number
}
type Task = {
  id: string
  filename: string
  provider: string
  status: string
  error: string
  created: number
  result?: {
    scene_analysis?: string
    summary: string
    model: string
    plate_comparison?: { variants: string[]; status: string }
    frames: ImageFrame[]
    frame_count: number
    objects: { frame_id: string; label: string; score: number }[]
    observations: {
      frame_id: string
      description: string
      category?: string
      severity?: string
      suspected_violation: boolean
    }[]
    readings: { frame_id: string; number: string; readability: string }[]
  }
}
const labels: Record<string, string> = {
  queued: 'В очереди',
  processing: 'Анализируется',
  done: 'Готово',
  failed: 'Ошибка',
  purged: 'Материалы удалены',
  person: 'Человек',
  car: 'Автомобиль',
  bus: 'Автобус',
  truck: 'Грузовик',
  motorcycle: 'Мотоцикл',
}
export default function Manual() {
  const [role, setRole] = useState(''),
    [provider, setProvider] = useState('local'),
    [configured, setConfigured] = useState(false),
    [localScenes, setLocalScenes] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [url, setUrl] = useState('')
  const [task, setTask] = useState<Task | null>(null),
    [history, setHistory] = useState<Task[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [region, setRegion] = useState<Region>(),
    [editing, setEditing] = useState(false),
    [dims, setDims] = useState({ width: 640, height: 360 }),
    [ready, setReady] = useState(false)
  const input = useRef<HTMLInputElement>(null),
    video = useRef<HTMLVideoElement>(null)
  const photo = file ? /\.(jpe?g|png|webp)$/i.test(file.name) : false
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch('/api/v2/' + path, options)
    const data = await response.json()
    if (!response.ok)
      throw new Error(
        typeof data.detail === 'string'
          ? data.detail
          : 'Не удалось выполнить запрос'
      )
    return path.startsWith('analyses/') ? normalizeTask(data) : data
  }
  useEffect(() => {
    request('status')
      .then((s) => setRole(s.role))
      .catch(() => setRole('unauthorized'))
    request('settings/scene-policy')
      .then((s) => setLocalScenes(s.policy.local_enabled))
      .catch(() => {})
    request('settings/openrouter')
      .then((s) => setConfigured(s.configured))
      .catch(() => {})
    request('analyses')
      .then(setHistory)
      .catch(() => {})
  }, [])
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url]
  )
  useEffect(() => {
    if (!task || !['queued', 'processing'].includes(task.status)) return
    let live = true
    const timer = setInterval(
      () =>
        request(`analyses/${task.id}`)
          .then((data) => {
            if (live) {
              setTask(data)
              if (data.status === 'done' || data.status === 'failed')
                request('analyses').then(setHistory)
            }
          })
          .catch((e) => {
            if (live) setError(e.message)
          }),
      2000
    )
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [task?.id, task?.status])
  function choose(f?: File) {
    if (!f || busy) return
    const isPhoto = /\.(jpe?g|png|webp)$/i.test(f.name)
    if (!isPhoto && !/\.(mp4|mov|webm|avi)$/i.test(f.name)) {
      setError('Нужны JPG/PNG/WebP или MP4/MOV/WebM/AVI')
      return
    }
    if (!f.size || f.size > (isPhoto ? 20 : 250) * 1024 * 1024) {
      setError('Фото до 20 МБ, видео до 250 МБ')
      return
    }
    setFile(f)
    setUrl(URL.createObjectURL(f))
    setRegion(undefined)
    setEditing(false)
    setTask(null)
    setReady(false)
    setError('')
  }
  async function analyze() {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('provider', provider)
      if (provider === 'openrouter' && region)
        body.append('region', JSON.stringify(region))
      const data = await request('analyses', { method: 'POST', body })
      setTask({
        ...data,
        filename: file.name,
        provider,
        error: '',
        created: Date.now() / 1000,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка анализа')
    } finally {
      setBusy(false)
    }
  }
  function exportReport() {
    const link = document.createElement('a')
    const uri = URL.createObjectURL(
      new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' })
    )
    link.href = uri
    link.download = 'osc-analysis.json'
    link.click()
    URL.revokeObjectURL(uri)
  }
  const processing = task && ['queued', 'processing'].includes(task.status)
  const result = task?.result
  const displayed =
    result?.frames?.filter((f) =>
      task?.provider === 'local' ? f.id.startsWith('a') : true
    ) || []
  return (
    <>
      <Head>
        <title>ОСЦ — Анализ фото и видео</title>
      </Head>
      <AppShell active="manual" role={role}>
        <main className="content">
          <nav className="manual-nav">
            <a href="/">← Камеры и происшествия</a>
            {role === 'admin' && <a href="/settings">Настройки OpenRouter</a>}
          </nav>
          <div className="page-heading">
            <div>
              <div className="eyebrow">РУЧНОЙ АНАЛИЗ</div>
              <h1>Фото и видео</h1>
              <p>
                Выберите файл и способ анализа. Результаты сохраняются на
                сервере.
              </p>
            </div>
          </div>
          {role === 'unauthorized' ? (
            <section className="panel v2-section">
              <p>
                Сначала{' '}
                <a className="text-button" href="/">
                  войдите в систему
                </a>{' '}
                на главной странице.
              </p>
            </section>
          ) : (
            <>
              <div className="analysis-grid">
                <section className="panel upload-panel">
                  <h2>Материалы для анализа</h2>
                  {file ? (
                    <div className="video-area">
                      <RegionSelector
                        width={dims.width}
                        height={dims.height}
                        region={region}
                        editing={editing}
                        onChange={setRegion}
                      >
                        {photo ? (
                          <img
                            src={url}
                            alt="Загруженное фото"
                            onLoad={(e) => {
                              setDims({
                                width: e.currentTarget.naturalWidth,
                                height: e.currentTarget.naturalHeight,
                              })
                              setReady(true)
                            }}
                            onError={() => {
                              setReady(false)
                              setError('Не удалось открыть фото')
                            }}
                          />
                        ) : (
                          <video
                            ref={video}
                            src={url}
                            controls={!editing}
                            onLoadedMetadata={(e) => {
                              setDims({
                                width: e.currentTarget.videoWidth,
                                height: e.currentTarget.videoHeight,
                              })
                              setReady(
                                Number.isFinite(e.currentTarget.duration) &&
                                  e.currentTarget.duration > 0 &&
                                  e.currentTarget.duration <= 120
                              )
                              if (e.currentTarget.duration > 120)
                                setError(
                                  'Максимальная длительность видео — 120 секунд'
                                )
                            }}
                            onError={() => {
                              setError(
                                'Браузер не читает видео. Рекомендуется MP4/H.264'
                              )
                              setReady(false)
                            }}
                          />
                        )}
                      </RegionSelector>
                      <div className="file-row">
                        <strong>{file.name}</strong>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => input.current?.click()}
                        >
                          Заменить
                        </button>
                      </div>
                      {provider === 'openrouter' && ready && (
                        <div className="region-controls">
                          <button
                            className="secondary-button"
                            disabled={busy || Boolean(processing)}
                            onClick={() => {
                              video.current?.pause()
                              setEditing(!editing)
                            }}
                          >
                            {editing ? 'Готово' : 'Выделить номер'}
                          </button>
                          {region && (
                            <button
                              className="text-button"
                              onClick={() => {
                                setRegion(undefined)
                                setEditing(false)
                              }}
                            >
                              Убрать область
                            </button>
                          )}
                          <p>
                            Вырезка отправится в исходном разрешении. В видео
                            рамка неподвижна — она должна оставаться на одном
                            автомобиле.
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      className="dropzone"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault()
                        choose(e.dataTransfer.files[0])
                      }}
                    >
                      <div className="upload-symbol">↥</div>
                      <h3>Перетащите фото или видео</h3>
                      <button
                        className="secondary-button"
                        onClick={() => input.current?.click()}
                      >
                        Выбрать файл
                      </button>
                      <p>Фото до 20 МБ · видео до 250 МБ и 120 секунд</p>
                    </div>
                  )}
                  <input
                    className="sr-only"
                    type="file"
                    ref={input}
                    accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.avi"
                    aria-label="Выбрать фото или видео"
                    onChange={(e) => {
                      choose(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                </section>
                <section className="panel settings-panel">
                  <h2>Способ анализа</h2>
                  <div className="provider-options">
                    <label>
                      <input
                        type="radio"
                        name="provider"
                        value="local"
                        checked={provider === 'local'}
                        disabled={busy || Boolean(processing)}
                        onChange={() => {
                          setProvider('local')
                          setEditing(false)
                        }}
                      />
                      <strong>Локальная модель</strong>
                      <small>
                        {localScenes
                          ? 'Объекты и анализ сцен через подключённую локальную vision-модель.'
                          : 'Только объекты: люди и транспорт. Повреждения и аварии не оцениваются.'}
                      </small>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="provider"
                        value="openrouter"
                        checked={provider === 'openrouter'}
                        disabled={busy || Boolean(processing)}
                        onChange={() => setProvider('openrouter')}
                      />
                      <strong>OpenRouter</strong>
                      <small>
                        Анализ сцены и чтение номеров по изображениям. Расходует
                        баланс ключа.
                      </small>
                    </label>
                  </div>
                  <p className="plate-disclaimer">
                    {provider === 'local'
                      ? localScenes
                        ? 'Локальный анализ включает YOLOX Nano и подключённую vision-модель. Проверяются сценарии аварий и нарушений из настроек. Качество и скорость зависят от модели.'
                        : 'YOLOX Nano распознаёт объекты и отмечает их рамками. Само наличие машины не является нарушением. Чтение номеров и распознавание свалок этой моделью не выполняются.'
                      : configured
                      ? 'Ключ настроен. Фото или выборка до 12 изображений отправятся в OpenRouter. При необходимости выделите номер.'
                      : 'Ключ пока не настроен. Администратор может добавить его в настройках сайта без перезапуска.'}
                  </p>
                  <button
                    className="primary-button"
                    disabled={
                      !ready ||
                      !role ||
                      busy ||
                      Boolean(processing) ||
                      editing ||
                      (provider === 'openrouter' && !configured)
                    }
                    onClick={analyze}
                  >
                    {busy
                      ? 'Загружаем файл…'
                      : processing
                      ? labels[task!.status] + '…'
                      : 'Начать анализ'}{' '}
                    →
                  </button>
                  {processing && (
                    <p className="plate-disclaimer" role="status">
                      Обработка выполняется на сервере. Можно дождаться
                      результата здесь или открыть его из истории позже.
                    </p>
                  )}
                </section>
              </div>
              {error && (
                <div className="error-message" role="alert">
                  {error}
                </div>
              )}
              {task && ['failed', 'purged'].includes(task.status) && (
                <div className="error-message" role="alert">
                  {task.error}
                </div>
              )}
              {result?.frames && (
                <section className="panel v2-section">
                  <div className="panel-heading">
                    <h2>
                      Результат ·{' '}
                      {task?.provider === 'local'
                        ? 'Локальная модель'
                        : 'OpenRouter'}
                    </h2>
                    <button className="text-button" onClick={exportReport}>
                      Скачать отчёт
                    </button>
                  </div>
                  <p className="result-summary">{result.summary}</p>
                  {result.scene_analysis === 'unsupported' && (
                    <p className="v2-warning">
                      Анализ аварий и нарушений не выполнялся: YOLOX Nano
                      распознаёт только объекты. Выберите OpenRouter или
                      подключите локальную vision-модель в настройках.
                    </p>
                  )}
                  <p className="plate-disclaimer">
                    Модель: {result.model}. Изображений сцены:{' '}
                    {result.frame_count}. Это наблюдения для проверки, не
                    юридическое заключение. Для видео события между выбранными
                    кадрами могут быть пропущены.
                  </p>
                  {result.plate_comparison && (
                    <p className="v2-warning">
                      Номер по вырезкам:{' '}
                      {result.plate_comparison.variants.join(' / ') ||
                        'не прочитан'}
                      .{' '}
                      {result.plate_comparison.status === 'conflict'
                        ? 'Прочтения расходятся — требуется проверка.'
                        : result.plate_comparison.status === 'agreement'
                        ? 'Есть совпадения на разных изображениях, но номер нужно проверить вручную.'
                        : 'Недостаточно независимых читаемых изображений для сопоставления.'}
                    </p>
                  )}
                  {result.observations?.map((o, i) => (
                    <article
                      className={`finding ${
                        o.suspected_violation ? 'finding-alert' : ''
                      }`}
                      key={i}
                    >
                      <strong>
                        {o.suspected_violation
                          ? '⚠ Сигнал для проверки · '
                          : 'Наблюдение · '}
                        {o.frame_id}
                        {o.severity === 'critical' ? ' · Срочно' : ''}
                      </strong>
                      <p>{o.description}</p>
                      <small>
                        {o.suspected_violation
                          ? 'Признак для проверки'
                          : 'Наблюдение'}
                      </small>
                    </article>
                  ))}
                  <div className="manual-results">
                    {displayed.map((frame) => (
                      <figure key={frame.id}>
                        <a
                          href={`/api/v2/analyses/${task!.id}/images/${
                            frame.id
                          }`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={`/api/v2/analyses/${task!.id}/images/${
                              frame.id
                            }`}
                            alt={`Результат анализа ${frame.id}`}
                            loading="lazy"
                          />
                        </a>
                        <figcaption>
                          <strong>
                            {frame.id} ·{' '}
                            {typeof frame.timestamp === 'number'
                              ? frame.timestamp.toFixed(1)
                              : '—'}{' '}
                            с
                          </strong>
                          <small>
                            {frame.width}×{frame.height} px
                          </small>
                          {result.objects
                            ?.filter(
                              (o) => o.frame_id === frame.id.replace(/^a/, 's')
                            )
                            .map((o, i) => (
                              <span key={i}>
                                {labels[o.label] || o.label}:{' '}
                                {(o.score * 100).toFixed(0)}%
                              </span>
                            ))}
                          {result.readings
                            ?.filter((r) => r.frame_id === frame.id)
                            .map((r, i) => (
                              <span key={i}>
                                Номер: {r.number || 'не прочитан'} ·{' '}
                                {r.readability === 'readable'
                                  ? 'прочтение модели'
                                  : 'требует проверки'}
                              </span>
                            ))}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                  {Boolean(result.readings?.length) && (
                    <p className="plate-disclaimer">
                      Каждый номер прочитан по указанному изображению.
                      Совпадение ответов одной модели не доказывает правильность
                      номера; сверяйте символы по вырезкам.
                    </p>
                  )}
                </section>
              )}
              <section className="panel v2-section">
                <h2>История анализов</h2>
                {history.length ? (
                  history.map((item) => (
                    <button
                      className="v2-event"
                      key={item.id}
                      onClick={() =>
                        request(`analyses/${item.id}`)
                          .then(setTask)
                          .catch((e) => setError(e.message))
                      }
                    >
                      <strong>{item.filename}</strong>
                      <span>
                        {item.provider === 'local'
                          ? 'Локальная модель'
                          : 'OpenRouter'}{' '}
                        · {labels[item.status] || item.status}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="plate-disclaimer">
                    После загрузки здесь появятся сохранённые результаты.
                  </p>
                )}
              </section>
            </>
          )}
        </main>
      </AppShell>
    </>
  )
}
