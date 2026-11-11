import ScenePolicyEditor from '../components/ScenePolicyEditor'
import { AppShell } from '../components/Interface'
import Head from 'next/head'
import { FormEvent, useEffect, useState } from 'react'
export default function Settings() {
  const [username, setUsername] = useState('presenter'),
    [password, setPassword] = useState('')
  const [role, setRole] = useState(''),
    [configured, setConfigured] = useState(false),
    [model, setModel] = useState('google/gemini-3.8-flash'),
    [key, setKey] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  async function request(path: string, options: RequestInit = {}) {
    const r = await fetch('/api/v2/' + path, options),
      data = await r.json()
    if (!r.ok)
      throw new Error(
        typeof data.detail === 'string' ? data.detail : 'Ошибка запроса'
      )
    return data
  }
  useEffect(() => {
    request('settings/presentation')
      .then((s) => setUsername(s.username))
      .catch(() => {})
    request('status')
      .then((s) => setRole(s.role))
      .catch((e) => setMessage(e.message))
    request('settings/openrouter')
      .then((s) => {
        setConfigured(s.configured)
        setModel(s.model)
      })
      .catch((e) => setMessage(e.message))
  }, [])
  async function run(work: () => Promise<void>) {
    setBusy(true)
    setMessage('')
    try {
      await work()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setBusy(false)
    }
  }
  function save(e: FormEvent) {
    e.preventDefault()
    run(async () => {
      await request('settings/openrouter', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, key: key || null }),
      })
      setKey('')
      const s = await request('settings/openrouter')
      setConfigured(s.configured)
      setMessage(
        'Сохранено. Следующий анализ использует новые настройки; перезапуск не нужен.'
      )
    })
  }
  return (
    <>
      <Head>
        <title>ОСЦ — Настройки</title>
      </Head>
      <AppShell active="settings" role={role}>
        <main className="content">
          <a className="text-button" href="/">
            ← Камеры
          </a>{' '}
          ·{' '}
          <a className="text-button" href="/manual">
            Фото и видео
          </a>
          <div className="page-heading">
            <h1>Настройки анализа</h1>
          </div>
          <section className="panel v2-section">
            <h2>OpenRouter</h2>
            <p className="plate-disclaimer">
              Статус: {configured ? 'ключ настроен' : 'ключ не задан'}.
              Локальная модель работает без этого ключа.
            </p>
            {message && (
              <p role="status" className="v2-warning">
                {message}
              </p>
            )}
            {role === 'admin' ? (
              <>
                <form className="v2-form" onSubmit={save}>
                  <label>
                    Модель
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    API-ключ
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      placeholder={
                        configured
                          ? 'Оставьте пустым, чтобы сохранить текущий'
                          : 'Вставьте ключ'
                      }
                    />
                  </label>
                  <small>
                    Ключ хранится зашифрованным на сервере и не возвращается в
                    браузер.
                  </small>
                  <button className="primary-button" disabled={busy}>
                    Сохранить
                  </button>
                </form>
                <button
                  className="secondary-button"
                  disabled={busy || !configured}
                  onClick={() =>
                    run(async () => {
                      const r = await request('settings/openrouter/test', {
                        method: 'POST',
                      })
                      setMessage(
                        `Подключение работает. Остаток лимита ключа: ${
                          r.remaining === null ? 'не задан' : '$' + r.remaining
                        }.`
                      )
                    })
                  }
                >
                  Проверить ключ без анализа
                </button>
              </>
            ) : (
              <p className="plate-disclaimer">
                Изменять ключ и модель может администратор. Для входа откройте
                главную страницу.
              </p>
            )}
          </section>
          {role === 'admin' && <ScenePolicyEditor />}
          {role === 'admin' && (
            <section className="panel v2-section">
              <h2>Доступ для презентации</h2>
              <p className="plate-disclaimer">
                Демонстратору нужны только ссылка, логин и пароль. Этот аккаунт
                может смотреть камеры и анализировать файлы, но не менять ключи
                и адреса камер. Смена пароля завершит его старые сессии.
              </p>
              <form
                className="v2-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  run(async () => {
                    await request('settings/presentation', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ username, password }),
                    })
                    setPassword('')
                    setMessage(
                      'Логин и пароль сохранены. Их можно передать демонстратору; перезапуск не нужен.'
                    )
                  })
                }}
              >
                <label>
                  Логин демонстратора
                  <input
                    required
                    minLength={3}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </label>
                <label>
                  Новый пароль демонстратора
                  <input
                    required
                    minLength={12}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <button className="primary-button" disabled={busy}>
                  Сохранить доступ
                </button>
              </form>
            </section>
          )}
        </main>
      </AppShell>
    </>
  )
}
