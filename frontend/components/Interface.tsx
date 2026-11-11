import { ReactNode, useEffect, useRef, useId, useState } from 'react'
import Link from 'next/link'

type IconName =
  | 'grid'
  | 'camera'
  | 'file'
  | 'settings'
  | 'logout'
  | 'arrow'
  | 'plus'
  | 'check'
  | 'clock'
  | 'search'
  | 'shield'
  | 'sliders'
  | 'trash'
  | 'download'
  | 'close'
  | 'refresh'
  | 'eye'
const paths: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3M7 10h5" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6M8 14h8M8 17h5" />
    </>
  ),
  settings: (
    <>
      <path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H5v16h4M10 12h11m-4-4 4 4-4 4" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="8" cy="6" r="2" fill="currentColor" />
      <circle cx="16" cy="12" r="2" fill="currentColor" />
      <circle cx="10" cy="18" r="2" fill="currentColor" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  refresh: (
    <>
      <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
}
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}
export function AppShell({
  children,
  active,
  role,
  live,
  onLogout,
}: {
  children: ReactNode
  active: 'monitor' | 'manual' | 'settings'
  role?: string
  live?: number
  onLogout?: () => void
}) {
  const [day, setDay] = useState('Ситуационный мониторинг')
  useEffect(
    () =>
      setDay(
        new Date().toLocaleDateString('ru-RU', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'Europe/Moscow',
        })
      ),
    []
  )
  const authorised = role === 'admin' || role === 'reviewer'
  return (
    <div className="app-shell">
      <aside className="app-side">
        <Link href="/" className="app-brand">
          <span className="app-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>ОСЦ</strong>
            <small>Ситуационный центр</small>
          </span>
        </Link>
        <div className="side-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav aria-label="Основная навигация">
          <Link href="/" className={active === 'monitor' ? 'active' : ''}>
            <Icon name="grid" />
            <span>Мониторинг</span>
          </Link>
          <Link href="/manual" className={active === 'manual' ? 'active' : ''}>
            <Icon name="file" />
            <span>Фото и видео</span>
          </Link>
          {role === 'admin' && (
            <Link
              href="/settings"
              className={active === 'settings' ? 'active' : ''}
            >
              <Icon name="settings" />
              <span>Настройки</span>
            </Link>
          )}
        </nav>
        <div className="side-info">
          <span className="side-rule" />
          <Icon name="shield" size={23} />
          <strong>
            Технологии наблюдают.
            <br />
            Человек принимает решение.
          </strong>
          <p>
            Каждый сигнал проходит
            <br />
            проверку специалистом.
          </p>
          <span className="version-tag">ПИЛОТ · 2.1</span>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-top">
          <span>
            Оперативная аналитика <span className="top-divider">/</span>{' '}
            <strong>
              {active === 'monitor'
                ? 'Обзор системы'
                : active === 'manual'
                ? 'Анализ материалов'
                : 'Настройки'}
            </strong>
          </span>
          <div className="top-tools">
            {live !== undefined && (
              <span className={`system-state ${live ? 'is-live' : ''}`}>
                <i />
                {live ? 'Обработка активна' : 'Ожидание обработчика'}
              </span>
            )}
            {authorised && (
              <>
                <span className="user-role">
                  <span>{role === 'admin' ? 'А' : 'С'}</span>
                  {role === 'admin' ? 'Администратор' : 'Специалист'}
                </span>
                <button
                  className="icon-button"
                  aria-label="Выйти"
                  title="Выйти"
                  onClick={
                    onLogout ||
                    (() => {
                      fetch('/api/v2/logout', { method: 'POST' }).finally(() =>
                        window.location.assign('/')
                      )
                    })
                  }
                >
                  <Icon name="logout" />
                </button>
              </>
            )}
          </div>
        </header>
        <div className="app-content">
          <div className="page-context">
            <span>ЕДИНАЯ СИСТЕМА МОНИТОРИНГА</span>
            <time>{day}</time>
          </div>
          {children}
          <footer className="app-footer">
            <span>© ОСЦ · Система поддержки решений</span>
            <span>Результаты ИИ требуют проверки специалистом</span>
          </footer>
        </div>
      </div>
    </div>
  )
}
export function Dialog({
  title,
  children,
  close,
  wide = false,
}: {
  title: string
  children: ReactNode
  close: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId()
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      className={`app-dialog ${wide ? 'dialog-wide' : ''}`}
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО ОСЦ</span>
          <h2 id={id}>{title}</h2>
        </div>
        <button className="icon-button" aria-label="Закрыть" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  )
}
