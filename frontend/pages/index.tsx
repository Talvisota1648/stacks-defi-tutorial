import Head from 'next/head'
import { AppShell, Dialog, Icon } from '../components/Interface'
import { FormEvent, useEffect, useState } from 'react'
import CameraGallery from '../components/CameraGallery'
import RegionSelector from '../components/RegionSelector'
import type { Region } from '../lib/analysis'

type Rule = {
  id: string
  type: string
  polygon: number[][]
  dwell_seconds: number
  cooldown_seconds: number
}
type Source = {
  id: string
  name: string
  kind: string
  enabled: boolean
  source_env: string
  status: string
  sample_fps: number
  last_frame: number | null
  error: string
  rules: Rule[]
}
type Incident = {
  category_name?: string
  source_name?: string
  id: string
  source_id: string
  category: string
  description: string
  detected_at: number
  version: number
  status: string
  reviewer: string
  comment: string
  evidence: {
    frame_offset: number
    label: string
    dwell_seconds: number
    model: string
    analysis_kind?: string
    severity?: string
    detector_score: number | null
    frame: { sha256: string }
    clip: { sha256: string }
    context_clips?: { captured_at: number }[]
  }
}
const date = (n: number | null) =>
  n
    ? new Date(n * 1000).toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
      }) + ' МСК'
    : '—'
const statusText: Record<string, string> = {
  pending: 'На проверке',
  approved: 'Утверждено',
  rejected: 'Отклонено',
  online: 'Поток поступает',
  connecting: 'Подключение',
  disabled: 'Выключен',
  error: 'Ошибка',
  queued: 'В очереди',
  processing: 'Обработка',
  done: 'Обработано',
  stalled: 'Нет новых клипов',
  failed: 'Ошибка обработки',
  cancelled: 'Отменено',
  purged: 'Удалён по сроку хранения',
}
export default function Control() {
  const [token, setToken] = useState(''),
    [draftToken, setDraftToken] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [sources, setSources] = useState<Source[]>([]),
    [events, setEvents] = useState<Incident[]>([]),
    [jobs, setJobs] = useState<any[]>([]),
    [status, setStatus] = useState<any>(null)
  const [filter, setFilter] = useState('pending'),
    [selected, setSelected] = useState<Incident | null>(null),
    [comment, setComment] = useState(''),
    [busy, setBusy] = useState(false)
  const [loginName, setLoginName] = useState(''),
    [loginPassword, setLoginPassword] = useState(''),
    [cameraUrl, setCameraUrl] = useState('')
  const [name, setName] = useState(''),
    [kind, setKind] = useState('rtsp'),
    [envName, setEnvName] = useState('CAMERA_01_URL'),
    [fps, setFps] = useState('0.5')
  const [latitude, setLatitude] = useState(''),
    [longitude, setLongitude] = useState('')
  const [edit, setEdit] = useState<Source | null>(null),
    [preview, setPreview] = useState(''),
    [frameImage, setFrameImage] = useState(''),
    [clipUrl, setClipUrl] = useState('')
  const [region, setRegion] = useState<Region>(),
    [dims, setDims] = useState({ width: 640, height: 360 }),
    [ruleType, setRuleType] = useState('vehicle_dwell'),
    [dwell, setDwell] = useState('15')
  const [showAdd, setShowAdd] = useState(false),
    [deleteTarget, setDeleteTarget] = useState<Source | null>(null),
    [editFps, setEditFps] = useState('0.5'),
    [search, setSearch] = useState(''),
    [report, setReport] = useState<any>(null)
  async function api(path: string, options: RequestInit = {}) {
    const response = await fetch(`/api/v2/${path}`, {
      ...options,
      headers: {
        ...(token !== 'session' ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(
        typeof body.detail === 'string'
          ? body.detail
          : `Ошибка ${response.status}: проверьте заполненные поля`
      )
    }
    return response
  }
  async function signIn(withToken = false) {
    setError('')
    setBusy(true)
    try {
      const response = await fetch(
        `/api/v2/${withToken ? 'token-login' : 'login'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            withToken
              ? { token: draftToken }
              : { username: loginName, password: loginPassword }
          ),
        }
      )
      const body = await response.json()
      if (!response.ok)
        throw new Error(
          typeof body.detail === 'string' ? body.detail : 'Не удалось войти'
        )
      setDraftToken('')
      setLoginPassword('')
      setToken('session')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка входа')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    fetch('/api/v2/status')
      .then((r) => {
        if (r.ok) setToken('session')
      })
      .catch(() => {})
  }, [])
  async function refresh() {
    try {
      const results = await Promise.all(
        ['status', 'sources', `events?status=${filter}`, 'jobs'].map((path) =>
          api(path).then((r) => r.json())
        )
      )
      setStatus(results[0])
      setSources(results[1])
      setEvents(results[2])
      setJobs(results[3])
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось обновить данные')
    }
  }
  useEffect(() => {
    if (!token) return
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [token, filter])
  useEffect(() => {
    let live = true
    const urls: string[] = []
    setFrameImage('')
    setClipUrl('')
    if (selected)
      api(`events/${selected.id}/evidence/frame`)
        .then((r) => r.blob())
        .then((blob) => {
          const url = URL.createObjectURL(blob)
          urls.push(url)
          if (live) setFrameImage(url)
          else URL.revokeObjectURL(url)
        })
        .catch((e) => {
          if (live) setError(e.message)
        })
    return () => {
      live = false
      urls.forEach(URL.revokeObjectURL)
    }
  }, [selected?.id, token])
  useEffect(
    () => () => {
      if (clipUrl) URL.revokeObjectURL(clipUrl)
    },
    [clipUrl]
  )
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview)
    },
    [preview]
  )
  async function action(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка операции')
    } finally {
      setBusy(false)
    }
  }
  async function add(e: FormEvent) {
    e.preventDefault()
    await action(async () => {
      await api('sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          kind,
          source_env: kind === 'rtsp' && !cameraUrl ? envName : '',
          rtsp_url: kind === 'rtsp' && cameraUrl ? cameraUrl : null,
          sample_fps: Number(fps),
          latitude: latitude === '' ? null : Number(latitude),
          longitude: longitude === '' ? null : Number(longitude),
          enabled: true,
          rules: [],
        }),
      })
      setName('')
      setCameraUrl('')
      setShowAdd(false)
      setNotice(
        'Источник добавлен. После первого кадра настройте ограниченную зону.'
      )
    })
  }
  async function configure(source: Source) {
    setEditFps(String(source.sample_fps))
    setError('')
    setEdit(source)
    setPreview('')
    setRegion(undefined)
    setRuleType(source.rules[0]?.type || 'vehicle_dwell')
    setDwell(String(source.rules[0]?.dwell_seconds || 15))
    try {
      const blob = await (await api(`sources/${source.id}/preview`)).blob()
      setPreview(URL.createObjectURL(blob))
    } catch (e) {
      setPreview('')
    }
  }
  useEffect(() => {
    if (!report || !['queued', 'processing'].includes(report.status)) return
    let live = true
    const id = report.id
    const timer = setInterval(() => {
      api(`jobs/${id}/result`)
        .then((r) => r.json())
        .then((data) => {
          if (live)
            setReport((current: any) => (current?.id === id ? data : current))
        })
        .catch(() => {})
    }, 3000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [report?.id, report?.status, token])
  const workers =
    status?.processes?.filter(
      (p: any) =>
        p.role === 'worker' &&
        p.online &&
        ['ready', 'processing'].includes(p.details.status)
    ) || []
  const admin = status?.role === 'admin'
  const visibleSources = sources.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  )
  const online = sources.filter(
    (s) => s.enabled && s.status === 'online'
  ).length
  async function showReport(id: string) {
    await action(async () =>
      setReport(await (await api(`jobs/${id}/result`)).json())
    )
  }
  return (
    <>
      <Head>
        <title>ОСЦ — Мониторинг и аналитика</title>
        <meta
          name="description"
          content="Мониторинг камер, результаты анализа и проверка событий специалистом"
        />
      </Head>
      <AppShell
        active="monitor"
        role={status?.role}
        live={workers.length}
        onLogout={() => {
          fetch('/api/v2/logout', { method: 'POST' })
          setToken('')
          setStatus(null)
          setSelected(null)
          setDraftToken('')
        }}
      >
        {!token ? (
          <div className="login-layout">
            <section className="login-intro">
              <span className="eyebrow">ОПЕРАТИВНАЯ АНАЛИТИКА</span>
              <h1>
                Наблюдение.
                <br />
                Анализ.
                <br />
                <em>Обоснованные решения.</em>
              </h1>
              <p>
                Единое пространство для работы с камерами, материалами и
                сигналами. Искусственный интеллект помогает находить. Специалист
                — проверять.
              </p>
              <div className="login-principles">
                <span>
                  <Icon name="camera" />
                  Потоки и материалы
                </span>
                <span>
                  <Icon name="shield" />
                  Проверка человеком
                </span>
              </div>
              <div className="login-decoration" aria-hidden="true">
                <i />
                <i />
                <i />
                <span />
              </div>
            </section>
            <section className="panel v2-login">
              <span className="eyebrow">ДОСТУП К СИСТЕМЕ</span>
              <h2>Вход специалиста</h2>
              <p>
                Используйте логин и пароль,
                <br />
                полученные от организатора.
              </p>
              {error && (
                <div className="error-message" role="alert">
                  {error}
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  signIn()
                }}
              >
                <label htmlFor="login-name">Логин</label>
                <input
                  id="login-name"
                  autoComplete="username"
                  required
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  placeholder="Ваш логин"
                />
                <label htmlFor="login-password">Пароль</label>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Введите пароль"
                />
                <button className="primary-button" disabled={busy}>
                  Войти в систему
                  <Icon name="arrow" />
                </button>
              </form>
              <details>
                <summary>Администратору: вход по токену</summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    signIn(true)
                  }}
                >
                  <label htmlFor="token">Токен доступа</label>
                  <input
                    id="token"
                    type="password"
                    autoComplete="off"
                    required
                    minLength={24}
                    value={draftToken}
                    onChange={(e) => setDraftToken(e.target.value)}
                  />
                  <button className="primary-button" disabled={busy}>
                    Подключиться
                    <Icon name="arrow" />
                  </button>
                </form>
              </details>
              <div className="login-security">
                <Icon name="shield" size={16} />
                <span>Защищённый доступ к материалам мониторинга</span>
              </div>
            </section>
          </div>
        ) : (
          <>
            <section className="monitor-hero">
              <div>
                <span className="eyebrow">ОПЕРАТИВНЫЙ КОНТУР</span>
                <h1>Мониторинг и аналитика</h1>
                <p>
                  От наблюдения к проверенному событию.
                  <br />
                  Все источники, материалы и решения — в одном пространстве.
                </p>
                <div className="hero-links">
                  <a href="#sources">
                    Источники наблюдения
                    <Icon name="arrow" size={17} />
                  </a>
                  <a href="/manual">
                    Анализировать файл
                    <Icon name="arrow" size={17} />
                  </a>
                </div>
              </div>
              <div className="hero-aside">
                <div className="hero-orbit" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <span>
                    <Icon name="shield" size={40} />
                  </span>
                </div>
                <div>
                  <span className="hero-aside-label">ПРИНЦИП РАБОТЫ</span>
                  <strong>
                    ИИ обнаруживает.
                    <br />
                    Специалист подтверждает.
                  </strong>
                </div>
              </div>
            </section>
            {error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="v2-notice" role="status">
                <Icon name="check" size={18} />
                {notice}
              </div>
            )}
            <div className="metric-grid">
              {(
                [
                  {
                    label: 'Источники наблюдения',
                    value: status?.sources,
                    detail: `${online} в сети · до 10 источников`,
                    icon: 'camera',
                  },
                  {
                    label: 'На проверке',
                    value: status?.pending,
                    detail: 'Сигналы ожидают решения',
                    icon: 'shield',
                  },
                  {
                    label: 'Клипы в очереди',
                    value: status?.queue,
                    detail: 'Ожидают или проходят анализ',
                    icon: 'clock',
                  },
                  {
                    label: 'Ошибки обработки',
                    value: status?.failed_jobs,
                    detail: 'Требуют внимания оператора',
                    icon: 'sliders',
                  },
                ] as const
              ).map((m) => (
                <section className="metric-card" key={m.label}>
                  <div>
                    <span>{m.label}</span>
                    <Icon name={m.icon} />
                  </div>
                  <strong>{m.value ?? '—'}</strong>
                  <small>{m.detail}</small>
                </section>
              ))}
            </div>
            {!workers.length && (
              <div className="v2-warning">
                <Icon name="clock" />
                Нет свежего подтверждения работы локальной модели. Материалы не
                считаются обработанными только по факту загрузки.
              </div>
            )}
            <section id="sources" className="monitor-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">01 · НАБЛЮДЕНИЕ</span>
                  <h2>
                    Источники наблюдения{' '}
                    <span className="section-count">{sources.length}</span>
                  </h2>
                  <p>Последние обработанные кадры и состояние подключений.</p>
                </div>
                {admin && (
                  <button
                    className="primary-button compact"
                    onClick={() => setShowAdd(true)}
                  >
                    <Icon name="plus" size={18} />
                    Добавить источник
                  </button>
                )}
              </div>
              <div className="source-toolbar">
                <div className="list-label">
                  <span className="tiny-dot" />
                  {online} в сети
                  <span className="toolbar-divider" />
                  {sources.length - online} выключено или ожидают подключения
                </div>
                <label className="search-field">
                  <Icon name="search" size={18} />
                  <input
                    aria-label="Поиск камеры"
                    placeholder="Найти источник"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <div className="source-grid">
                {visibleSources.map((source) => (
                  <article className="source-card" key={source.id}>
                    <div className="source-card-heading">
                      <span className="source-type">
                        <Icon name="camera" size={17} />
                        {source.kind === 'rtsp'
                          ? 'RTSP-КАМЕРА'
                          : 'МОБИЛЬНЫЙ КОМПЛЕКС'}
                      </span>
                      <span
                        className={`source-state ${
                          source.enabled && source.status === 'online'
                            ? 'online'
                            : source.error
                            ? 'fault'
                            : ''
                        }`}
                      >
                        <i />
                        {source.enabled
                          ? statusText[source.status] || source.status
                          : 'Выключен'}
                      </span>
                    </div>
                    <CameraGallery sourceId={source.id} />
                    <div className="source-card-body">
                      <h3>{source.name}</h3>
                      <div className="source-meta">
                        <span>
                          <Icon name="clock" size={14} />
                          {source.sample_fps} кадр/с
                        </span>
                        <span>{source.rules.length} правил контроля</span>
                      </div>
                      <p className="source-last">
                        Последний клип: {date(source.last_frame)}
                      </p>
                      {source.error && (
                        <p className="source-error">{source.error}</p>
                      )}
                      <div className="source-card-actions">
                        {admin && (
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => configure(source)}
                          >
                            <Icon name="sliders" size={16} />
                            Настройки камеры
                          </button>
                        )}
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            const job = jobs.find(
                              (j) => j.source_id === source.id
                            )
                            if (job) showReport(job.id)
                            else
                              setNotice(
                                'У источника пока нет заданий. Результат появится после первого клипа.'
                              )
                          }}
                        >
                          Результаты
                          <Icon name="arrow" size={15} />
                        </button>
                        {admin && (
                          <details className="source-menu">
                            <summary
                              aria-label={`Действия с камерой ${source.name}`}
                            >
                              ···
                            </summary>
                            <div>
                              {source.kind === 'rtsp' && (
                                <button
                                  onClick={() =>
                                    action(async () => {
                                      await api(
                                        `sources/${source.id}/reconnect`,
                                        { method: 'POST' }
                                      )
                                      setNotice(
                                        'Переподключение запрошено. Поток восстановится автоматически.'
                                      )
                                    })
                                  }
                                >
                                  <Icon name="refresh" size={16} />
                                  Переподключить
                                </button>
                              )}
                              <button
                                onClick={() =>
                                  action(async () => {
                                    await api(`sources/${source.id}`, {
                                      method: 'PATCH',
                                      headers: {
                                        'Content-Type': 'application/json',
                                      },
                                      body: JSON.stringify({
                                        enabled: !source.enabled,
                                      }),
                                    })
                                  })
                                }
                              >
                                {source.enabled ? 'Выключить' : 'Включить'}
                              </button>
                              <button
                                className="danger-text"
                                onClick={() => {
                                  setError('')
                                  setDeleteTarget(source)
                                }}
                              >
                                <Icon name="trash" size={16} />
                                Удалить камеру
                              </button>
                            </div>
                          </details>
                        )}
                      </div>
                      {admin && source.kind === 'upload' && (
                        <label className="v2-upload">
                          Загрузить клип
                          <input
                            type="file"
                            accept=".mp4,.mov,.webm,.avi"
                            disabled={busy || !source.enabled}
                            onChange={(e) => {
                              const file = e.target.files?.[0]
                              e.target.value = ''
                              if (!file) return
                              if (file.size > 250 * 1024 * 1024) {
                                setError('Максимум 250 МБ')
                                return
                              }
                              action(async () => {
                                const body = new FormData()
                                body.append('file', file)
                                const response = await (
                                  await api(`sources/${source.id}/uploads`, {
                                    method: 'POST',
                                    body,
                                  })
                                ).json()
                                setNotice(
                                  response.duplicate
                                    ? 'Этот клип уже был загружен.'
                                    : 'Клип загружен и добавлен в очередь анализа.'
                                )
                              })
                            }}
                          />
                        </label>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {!visibleSources.length && (
                <div className="empty-panel">
                  <span className="empty-icon">
                    <Icon name="camera" size={30} />
                  </span>
                  <h3>
                    {sources.length
                      ? 'Источники не найдены'
                      : 'Подключите первый источник'}
                  </h3>
                  <p>
                    {sources.length
                      ? 'Попробуйте изменить поисковый запрос.'
                      : 'Добавьте RTSP-камеру или загрузку клипов мобильного комплекса. После обработки здесь появятся кадры.'}
                  </p>
                  {admin && !sources.length && (
                    <button
                      className="secondary-button"
                      onClick={() => setShowAdd(true)}
                    >
                      <Icon name="plus" size={16} />
                      Добавить источник
                    </button>
                  )}
                </div>
              )}
            </section>
            <section className="monitor-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">02 · РЕШЕНИЯ</span>
                  <h2>Проверка событий</h2>
                  <p>
                    Материалы доступны для передачи только после утверждения.
                  </p>
                </div>
                <select
                  aria-label="Статус событий"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value)
                    setSelected(null)
                  }}
                >
                  <option value="pending">На проверке</option>
                  <option value="approved">Утверждённые</option>
                  <option value="rejected">Отклонённые</option>
                  <option value="all">Все события</option>
                </select>
              </div>
              <div className="review-workspace">
                <div className="review-list">
                  <div className="review-list-title">
                    СОБЫТИЯ<span>{events.length}</span>
                  </div>
                  {events.length ? (
                    events.map((event) => (
                      <button
                        key={event.id}
                        className={`review-item ${
                          selected?.id === event.id ? 'selected' : ''
                        }`}
                        onClick={() => {
                          setSelected(event)
                          setComment('')
                        }}
                      >
                        <img
                          src={`/api/v2/events/${event.id}/evidence/frame`}
                          alt="Сохранённый кадр происшествия"
                          loading="lazy"
                        />
                        <div>
                          <span className={`event-state state-${event.status}`}>
                            {statusText[event.status]}
                          </span>
                          <strong>
                            {event.category_name ||
                              (event.category === 'vehicle_dwell'
                                ? 'Автомобиль в ограниченной зоне'
                                : 'Человек в ограниченной зоне')}
                          </strong>
                          <small>
                            {event.source_name ||
                              sources.find((s) => s.id === event.source_id)
                                ?.name ||
                              'Архивный источник'}
                          </small>
                          <time>{date(event.detected_at)}</time>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="review-list-empty">
                      <Icon name="check" size={24} />
                      <strong>Очередь пуста</strong>
                      <p>Здесь появятся новые сигналы для проверки.</p>
                    </div>
                  )}
                </div>
                <div className="review-detail">
                  {selected ? (
                    <>
                      <div className="review-detail-header">
                        <span className="eyebrow">МАТЕРИАЛЫ СОБЫТИЯ</span>
                        <span
                          className={`event-state state-${selected.status}`}
                        >
                          {statusText[selected.status]}
                        </span>
                      </div>
                      <h3>
                        {selected.category_name ||
                          (selected.category === 'vehicle_dwell'
                            ? 'Нахождение автомобиля в зоне'
                            : 'Присутствие человека в зоне')}
                      </h3>
                      <p className="plate-disclaimer">{selected.description}</p>
                      {frameImage && (
                        <img
                          className="v2-evidence"
                          src={frameImage}
                          alt="Подтверждающий кадр события"
                        />
                      )}
                      <div className="evidence-facts">
                        <span>
                          Объект<strong>{selected.evidence.label}</strong>
                        </span>
                        {selected.evidence.analysis_kind !== 'scene' && (
                          <span>
                            Длительность
                            <strong>
                              {selected.evidence.dwell_seconds.toFixed(1)} с
                            </strong>
                          </span>
                        )}
                        {typeof selected.evidence.detector_score ===
                          'number' && (
                          <span>
                            Оценка детектора
                            <strong>
                              {(selected.evidence.detector_score * 100).toFixed(
                                0
                              )}
                              %
                            </strong>
                          </span>
                        )}
                        {selected.evidence.analysis_kind === 'scene' && (
                          <span>
                            Модель сцены
                            <strong>{selected.evidence.model}</strong>
                          </span>
                        )}
                      </div>
                      <p className="fine-print">
                        Оценка относится к распознаванию объекта, а не к
                        вероятности нарушения.
                      </p>
                      {clipUrl ? (
                        <video className="v2-evidence" src={clipUrl} controls />
                      ) : (
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              setClipUrl(
                                URL.createObjectURL(
                                  await (
                                    await api(
                                      `events/${selected.id}/evidence/clip`
                                    )
                                  ).blob()
                                )
                              )
                            })
                          }
                        >
                          <Icon name="eye" size={17} />
                          Просмотреть клип
                        </button>
                      )}
                      {Boolean(selected.evidence.context_clips?.length) && (
                        <details className="evidence-details">
                          <summary>
                            Контекст до события:{' '}
                            {selected.evidence.context_clips?.length} клипов
                          </summary>
                          {selected.evidence.context_clips?.map(
                            (clip, index) => (
                              <button
                                className="text-button"
                                key={index}
                                disabled={busy}
                                onClick={() =>
                                  action(async () => {
                                    setClipUrl(
                                      URL.createObjectURL(
                                        await (
                                          await api(
                                            `events/${selected.id}/evidence/context-${index}`
                                          )
                                        ).blob()
                                      )
                                    )
                                  })
                                }
                              >
                                Клип {index + 1} · {date(clip.captured_at)}
                              </button>
                            )
                          )}
                        </details>
                      )}
                      <details className="evidence-details">
                        <summary>Контрольные суммы материалов</summary>
                        <p>Кадр: {selected.evidence.frame.sha256}</p>
                        <p>Клип: {selected.evidence.clip.sha256}</p>
                      </details>
                      {selected.status === 'pending' ? (
                        <div className="v2-form">
                          <label>
                            Заключение специалиста
                            <textarea
                              minLength={3}
                              maxLength={2000}
                              value={comment}
                              onChange={(e) => setComment(e.target.value)}
                              placeholder="Что подтверждено или почему событие отклонено"
                            />
                          </label>
                          <div className="decision-actions">
                            {['approved', 'rejected'].map((decision) => (
                              <button
                                className={
                                  decision === 'approved'
                                    ? 'primary-button compact'
                                    : 'secondary-button'
                                }
                                key={decision}
                                disabled={busy || comment.trim().length < 3}
                                onClick={() =>
                                  action(async () => {
                                    await api(`events/${selected.id}/review`, {
                                      method: 'POST',
                                      headers: {
                                        'Content-Type': 'application/json',
                                      },
                                      body: JSON.stringify({
                                        decision,
                                        version: selected.version,
                                        comment,
                                      }),
                                    })
                                    setSelected(null)
                                    setNotice(
                                      decision === 'approved'
                                        ? 'Событие утверждено и включено в интеграционную ленту.'
                                        : 'Событие отклонено. В интеграционную ленту не передаётся.'
                                    )
                                  })
                                }
                              >
                                {decision === 'approved' ? (
                                  <>
                                    <Icon name="check" size={16} />
                                    Утвердить
                                  </>
                                ) : (
                                  'Отклонить'
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="approved-note">
                          <Icon name="shield" />
                          {selected.reviewer}: {selected.comment}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="review-placeholder">
                      <span>
                        <Icon name="shield" size={44} />
                      </span>
                      <h3>
                        Решение начинается
                        <br />с проверки материалов
                      </h3>
                      <p>
                        Выберите событие слева, чтобы посмотреть
                        <br />
                        кадр, клип и основания срабатывания.
                      </p>
                      <div>
                        <Icon name="check" size={15} />
                        Без автоматического утверждения
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
            <section className="monitor-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">03 · ПРОЗРАЧНОСТЬ АНАЛИЗА</span>
                  <h2>Результаты обработки</h2>
                  <p>
                    Смотрите, какие объекты обнаружены — даже когда происшествий
                    нет.
                  </p>
                </div>
                <a className="text-button" href="/manual">
                  Анализировать свой файл
                  <Icon name="arrow" size={17} />
                </a>
              </div>
              <div className="jobs-table-wrap">
                <table className="jobs-table">
                  <thead>
                    <tr>
                      <th>Источник</th>
                      <th>Время поступления</th>
                      <th>Статус</th>
                      <th>Результат</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr key={job.id}>
                        <td>
                          <span className="table-source">
                            <Icon name="camera" size={17} />
                            {sources.find((s) => s.id === job.source_id)
                              ?.name || 'Архивный источник'}
                          </span>
                          {job.error && (
                            <small className="job-error">{job.error}</small>
                          )}
                        </td>
                        <td>{date(job.created)}</td>
                        <td>
                          <span className={`event-state state-${job.status}`}>
                            {statusText[job.status] || job.status}
                          </span>
                        </td>
                        <td>
                          <button
                            className="text-button"
                            disabled={busy || job.status === 'purged'}
                            onClick={() => showReport(job.id)}
                          >
                            Посмотреть
                            <Icon name="arrow" size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!jobs.length && (
                  <div className="empty-table">
                    <Icon name="file" />
                    <p>
                      После первого клипа здесь появятся задания и результаты.
                    </p>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
        {showAdd && (
          <Dialog title="Добавить источник" close={() => setShowAdd(false)}>
            <form className="v2-form" onSubmit={add}>
              <label>
                Название
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Подключение
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="rtsp">RTSP-камера</option>
                  <option value="upload">Загрузка клипов</option>
                </select>
              </label>
              {kind === 'rtsp' && (
                <>
                  <label>
                    Адрес RTSP
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="rtsp://…"
                      value={cameraUrl}
                      onChange={(e) => setCameraUrl(e.target.value)}
                    />
                  </label>
                  <details>
                    <summary>Адрес из переменной сервера</summary>
                    <input
                      aria-label="Имя переменной"
                      value={envName}
                      onChange={(e) => setEnvName(e.target.value)}
                    />
                  </details>
                </>
              )}
              <label>
                Частота анализа, кадров/с
                <input
                  type="number"
                  min="0.2"
                  max="5"
                  step="0.1"
                  required
                  value={fps}
                  onChange={(e) => setFps(e.target.value)}
                />
              </label>
              <div className="coordinate-fields">
                <label>
                  Широта (необязательно)
                  <input
                    type="number"
                    step="any"
                    min="-90"
                    max="90"
                    value={latitude}
                    onChange={(e) => setLatitude(e.target.value)}
                  />
                </label>
                <label>
                  Долгота (необязательно)
                  <input
                    type="number"
                    step="any"
                    min="-180"
                    max="180"
                    value={longitude}
                    onChange={(e) => setLongitude(e.target.value)}
                  />
                </label>
              </div>
              <button className="primary-button" disabled={busy}>
                Добавить источник
                <Icon name="plus" />
              </button>
              {error && (
                <p role="alert" className="error-message">
                  {error}
                </p>
              )}
            </form>
          </Dialog>
        )}
        {edit && admin && (
          <Dialog title={edit.name} close={() => setEdit(null)} wide>
            {edit.kind === 'rtsp' && (
              <form
                className="v2-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  const form = e.currentTarget
                  const rtsp_url = String(new FormData(form).get('url'))
                  action(async () => {
                    await api(`sources/${edit.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ rtsp_url }),
                    })
                    form.reset()
                    setEdit(null)
                    setNotice(
                      'Адрес сохранён. Камера переподключится автоматически.'
                    )
                  })
                }}
              >
                <h3>Подключение камеры</h3>
                <label>
                  Новая RTSP-ссылка
                  <input
                    type="password"
                    name="url"
                    required
                    autoComplete="off"
                    placeholder="rtsp://адрес:554/поток"
                  />
                </label>
                <button className="secondary-button" disabled={busy}>
                  Сохранить подключение
                </button>
              </form>
            )}

            <div className="v2-form">
              <h3>Частота обработки</h3>
              <label>
                Кадров в секунду (от 0,2 до 5)
                <input
                  type="number"
                  min="0.2"
                  max="5"
                  step="0.1"
                  value={editFps}
                  onChange={(e) => setEditFps(e.target.value)}
                />
              </label>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api(`sources/${edit.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ sample_fps: Number(editFps) }),
                    })
                    setNotice(
                      'Частота изменена. Новые задания используют новое значение.'
                    )
                    setEdit(null)
                  })
                }
              >
                Сохранить частоту
              </button>
              <h3>Зона контроля</h3>
              {preview ? (
                <RegionSelector
                  region={region}
                  onChange={setRegion}
                  editing
                  width={dims.width}
                  height={dims.height}
                >
                  <img
                    src={preview}
                    alt="Выделите зону контроля"
                    onLoad={(e) =>
                      setDims({
                        width: e.currentTarget.naturalWidth,
                        height: e.currentTarget.naturalHeight,
                      })
                    }
                  />
                </RegionSelector>
              ) : (
                <p>
                  Кадр пока не поступил. Настройте зону после первого
                  подключения.
                </p>
              )}
              <p className="fine-print">
                Выделите прямоугольную область на кадре. Сигналы формируются
                только по настроенным правилам.
              </p>
              <select
                aria-label="Правило контроля"
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value)}
              >
                <option value="vehicle_dwell">Автомобиль в зоне</option>
                <option value="person_zone">Человек в зоне</option>
              </select>
              <label>
                Минимальное время в зоне, секунд
                <input
                  type="number"
                  min="3"
                  max="3600"
                  value={dwell}
                  onChange={(e) => setDwell(e.target.value)}
                />
              </label>
              <button
                className="primary-button"
                disabled={busy || !region}
                onClick={() =>
                  action(async () => {
                    if (!region) return
                    const { x, y, width: w, height: h } = region
                    await api(`sources/${edit.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        rules: [
                          {
                            id: 'zone-1',
                            type: ruleType,
                            polygon: [
                              [x, y],
                              [x + w, y],
                              [x + w, y + h],
                              [x, y + h],
                            ],
                            dwell_seconds: Number(dwell),
                            cooldown_seconds: 60,
                          },
                        ],
                      }),
                    })
                    setEdit(null)
                    setNotice('Правило контроля сохранено.')
                  })
                }
              >
                Сохранить зону
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api(`sources/${edit.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ rules: [] }),
                    })
                    setEdit(null)
                    setNotice('Правила источника убраны.')
                  })
                }
              >
                Убрать правила источника
              </button>
              {error && (
                <p className="error-message" role="alert">
                  {error}
                </p>
              )}
            </div>
          </Dialog>
        )}
        {deleteTarget && (
          <Dialog title="Удалить камеру?" close={() => setDeleteTarget(null)}>
            <p>
              Источник «{deleteTarget.name}» будет отключён и убран из списка.
              Сохранённые события и подтверждающие материалы останутся доступны.
            </p>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api(`sources/${deleteTarget.id}`, { method: 'DELETE' })
                  setDeleteTarget(null)
                  setNotice('Камера удалена. Материалы событий сохранены.')
                })
              }
            >
              Удалить камеру
            </button>
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </Dialog>
        )}
        {report && (
          <Dialog
            title="Результат обработки"
            close={() => setReport(null)}
            wide
          >
            <div className="report-intro">
              <h3>{report.source_name}</h3>
              <span className={`event-state state-${report.status}`}>
                {statusText[report.status] || report.status}
              </span>
              <p>{date(report.captured_at)}</p>
            </div>
            {report.result ? (
              <>
                <div className="evidence-facts">
                  <span>
                    Проверено кадров
                    <strong>{report.result.analysed_frames}</strong>
                  </span>
                  <span>
                    Сигналов для проверки
                    <strong>{report.result.signals}</strong>
                  </span>
                  <span>
                    Модель<strong>{report.result.model}</strong>
                  </span>
                </div>
                <h3>Что обнаружено</h3>
                {Object.keys(report.result.peak_objects || {}).length ? (
                  <div className="object-summary">
                    {Object.entries(report.result.peak_objects).map(
                      ([label, count]) => (
                        <span key={label}>
                          {(
                            {
                              person: 'Человек',
                              car: 'Автомобиль',
                              bus: 'Автобус',
                              truck: 'Грузовик',
                              motorcycle: 'Мотоцикл',
                              bicycle: 'Велосипед',
                            } as Record<string, string>
                          )[label] || label}
                          : до <strong>{String(count)}</strong> в одном кадре
                        </span>
                      )
                    )}
                  </div>
                ) : (
                  <p>
                    На проанализированных кадрах объекты поддерживаемых классов
                    не обнаружены.
                  </p>
                )}
                <p className="fine-print">
                  Объекты на разных кадрах могут повторяться. Обнаружение
                  автомобиля или человека само по себе не означает нарушение.
                  Частота: {report.result.sample_fps} кадр/с.
                </p>
                <h3>Проверка аварий и нарушений</h3>
                {report.result.scene?.status === 'completed' ? (
                  <>
                    <p className="fine-print">
                      Модель: {report.result.scene.model}. Проверено
                      изображений: {report.result.scene.analysed_frames}. Повтор
                      похожих сигналов в одной области ограничен на 5 минут.
                    </p>
                    <p>{report.result.scene.summary}</p>
                    {report.result.scene.observations
                      ?.filter((o: any) => o.suspected_violation)
                      .map((o: any, i: number) => (
                        <article className="scene-observation" key={i}>
                          <strong>
                            {o.severity === 'critical' ? 'Срочно · ' : ''}Сигнал
                            для проверки · {o.frame_id}
                          </strong>
                          <p>{o.description}</p>
                        </article>
                      ))}
                  </>
                ) : (
                  <p className="scene-report-error">
                    {report.result.scene?.status === 'failed'
                      ? report.result.scene.error
                      : report.result.scene?.status === 'interval'
                      ? 'В этом клипе анализ сцены не выполнялся: действует интервал проверки камеры. Это не означает отсутствия опасности.'
                      : 'Анализ аварий и нарушений не выполнялся. Включите проверку сцен с камер в настройках. YOLOX Nano распознаёт только объекты.'}
                  </p>
                )}
                <h3>Кадры анализа</h3>
                <p className="fine-print">
                  До 12 кадров клипа с рамками обнаруженных объектов. Полный
                  анализ выполняется с заданной частотой.
                </p>
                <div className="report-frames">
                  {report.result.frames.map((frame: any) => (
                    <figure key={frame.id}>
                      <a
                        href={`/api/v2/jobs/${report.id}/images/${frame.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          src={`/api/v2/jobs/${report.id}/images/${frame.id}`}
                          alt={`Кадр на ${frame.offset} секунде с обнаруженными объектами`}
                          loading="lazy"
                        />
                      </a>
                      <figcaption>
                        <strong>+{frame.offset.toFixed(1)} с</strong>
                        <span>{frame.detections.length} объектов</span>
                      </figcaption>
                      <p>
                        {frame.detections
                          .map(
                            (d: any) =>
                              `${
                                (
                                  {
                                    person: 'Человек',
                                    car: 'Автомобиль',
                                    bus: 'Автобус',
                                    truck: 'Грузовик',
                                  } as Record<string, string>
                                )[d.label] || d.label
                              } ${Math.round(d.score * 100)}%`
                          )
                          .join(' · ') || 'Объекты не обнаружены'}
                      </p>
                    </figure>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-panel">
                <Icon name="clock" />
                <p>
                  {report.error ||
                    'Результат появится после завершения обработки. Окно обновляется автоматически.'}
                </p>
                {report.status === 'done' && (
                  <p>
                    Для клипов, обработанных до обновления, подробный отчёт не
                    сохранялся.
                  </p>
                )}
              </div>
            )}
          </Dialog>
        )}
      </AppShell>
    </>
  )
}
