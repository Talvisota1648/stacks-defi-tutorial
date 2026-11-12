import { useEffect, useState } from 'react'
export default function StorageSettings() {
  const [info, setInfo] = useState<any>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  async function refresh() {
    const r = await fetch('/api/v2/maintenance/storage')
    if (r.ok) setInfo(await r.json())
  }
  useEffect(() => {
    refresh().catch(() => {})
    const timer = setInterval(() => {
      refresh().catch(() => {})
    }, 30000)
    return () => clearInterval(timer)
  }, [])
  return (
    <section className="panel v2-section">
      <h2>Хранилище и автоочистка</h2>
      {info && (
        <>
          <p>
            Свободно: <strong>{(info.free_mb / 1024).toFixed(1)} ГБ</strong> из{' '}
            {(info.total_mb / 1024).toFixed(1)} ГБ.
          </p>
          {info.low && (
            <p className="error-message">
              Мало места. Запись может останавливаться до освобождения диска.
            </p>
          )}
          <p className="plate-disclaimer">
            Клипы без событий хранятся {info.camera_retention_hours} ч, ручные
            анализы без сигналов — {info.manual_retention_hours} ч. При нехватке
            места старые обработанные материалы удаляются раньше. Активные
            задания, последние кадры и материалы событий сохраняются.
          </p>
        </>
      )}
      <button
        className="secondary-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setMessage('Освобождаем место…')
          try {
            const r = await fetch('/api/v2/maintenance/cleanup', {
              method: 'POST',
            })
            const data = await r.json()
            if (!r.ok)
              throw Error(
                typeof data.detail === 'string' ? data.detail : 'Ошибка очистки'
              )
            setMessage(
              `Удалено клипов: ${data.jobs}; ручных анализов: ${
                data.analyses
              }. Освобождено ${data.freed_mb} МБ.${
                data.low
                  ? ' Места всё ещё недостаточно: активные задания и материалы событий не удаляются.'
                  : ''
              }`
            )
            await refresh()
          } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Ошибка очистки')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Очистка…' : 'Освободить место сейчас'}
      </button>
      {message && (
        <p className="v2-notice" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
