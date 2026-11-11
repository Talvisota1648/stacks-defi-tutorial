import { useEffect, useState } from 'react'
export default function ScenePolicyEditor() {
  const [config, setConfig] = useState<any>(null),
    [catalog, setCatalog] = useState<Record<string, string>>({}),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    fetch('/api/v2/settings/scene-policy')
      .then(async (r) => {
        if (!r.ok) throw Error('Не удалось прочитать сценарии')
        const data = await r.json()
        setConfig(data.policy)
        setCatalog(data.catalog)
      })
      .catch((e) => setMessage(e.message))
  }, [])
  const update = (key: string, value: any) =>
    setConfig((c: any) => ({ ...c, [key]: value }))
  return (
    <section className="panel v2-section scene-policy">
      <h2>Сценарии и запрещённые объекты</h2>
      <p className="plate-disclaimer">
        Настройте признаки, которые vision-модель ищет в фото, видео и на
        камерах. YOLOX Nano сам по себе не понимает эти сценарии. Сигналы
        требуют проверки специалистом.
      </p>
      {message && (
        <p className="v2-warning" role="status">
          {message}
        </p>
      )}
      {config && (
        <form
          className="v2-form"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setMessage('')
            try {
              const r = await fetch('/api/v2/settings/scene-policy', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
              })
              if (!r.ok) {
                const data = await r.json()
                throw Error(
                  typeof data.detail === 'string'
                    ? data.detail
                    : 'Проверьте поля настроек'
                )
              }
              setMessage(
                'Сценарии сохранены. Применяются к следующим анализам без перезапуска.'
              )
            } catch (e) {
              setMessage(e instanceof Error ? e.message : 'Ошибка сохранения')
            } finally {
              setBusy(false)
            }
          }}
        >
          <fieldset>
            <legend>Базовые сценарии</legend>
            <div className="scenario-grid">
              {Object.entries(catalog).map(([id, title]) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={config.enabled_types.includes(id)}
                    onChange={(e) =>
                      update(
                        'enabled_types',
                        e.target.checked
                          ? [...config.enabled_types, id]
                          : config.enabled_types.filter((t: string) => t !== id)
                      )
                    }
                  />
                  <span>{title}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Дополнительные типы ситуаций и критерии
            <textarea
              maxLength={6000}
              rows={5}
              value={config.custom_prompt}
              onChange={(e) => update('custom_prompt', e.target.value)}
              placeholder="Например: искать повреждённые автомобили у въезда; сообщать о перекрытии пожарного проезда. Включите сценарий «Дополнительный сценарий администратора»."
            />
          </label>
          <label>
            Запрещённые объекты — по одному в строке
            <textarea
              rows={4}
              maxLength={6500}
              value={config.forbidden_objects.join('\n')}
              onChange={(e) =>
                update('forbidden_objects', e.target.value.split('\n'))
              }
              onBlur={() =>
                update(
                  'forbidden_objects',
                  config.forbidden_objects
                    .map((s: string) => s.trim())
                    .filter(Boolean)
                )
              }
              placeholder="Шлагбаум поперёк пожарного проезда\nСтроительные отходы вне контейнера"
            />
          </label>
          <label>
            Модель для анализа сцен с камер
            <select
              value={config.provider}
              onChange={(e) => update('provider', e.target.value)}
            >
              <option value="openrouter">OpenRouter — платные запросы</option>
              <option value="local_vlm">
                Локальная vision-модель — свой сервер
              </option>
            </select>
          </label>
          <details>
            <summary>Подключить локальную vision-модель</summary>
            <p className="fine-print">
              Нужен отдельный работающий сервер с поддержкой изображений и
              OpenAI-совместимым API, например Ollama с qwen2.5vl:7b. YOLOX Nano
              не заменяет vision-модель. Эти поля не скачивают и не запускают
              модель.
            </p>
            <label>
              Адрес API
              <input
                required
                value={config.local_url}
                onChange={(e) => update('local_url', e.target.value)}
              />
            </label>
            <label>
              Имя vision-модели
              <input
                required
                value={config.local_model}
                onChange={(e) => update('local_model', e.target.value)}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={config.local_enabled}
                onChange={(e) => update('local_enabled', e.target.checked)}
              />
              Дополнять локальный анализ фото и видео этой vision-моделью
            </label>
          </details>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.camera_enabled}
              onChange={(e) => update('camera_enabled', e.target.checked)}
            />
            Автоматически проверять сцены со всех подключённых камер
          </label>
          <p className="fine-print">
            При OpenRouter это включает платные запросы: не чаще одного на
            камеру за заданный интервал, до 4 изображений в запросе. Не
            отправляем каждый кадр. Повтор похожего сигнала в одной области
            подавляется на 5 минут. Скорость обработки зависит от модели;
            события между проверками могут быть пропущены.
          </p>
          <label>
            Интервал проверки сцены одной камеры, секунд
            <input
              type="number"
              min={10}
              max={3600}
              required
              value={config.camera_interval}
              onChange={(e) =>
                update('camera_interval', Number(e.target.value))
              }
            />
          </label>
          <label>
            Кадров сцены в запросе
            <input
              type="number"
              min={1}
              max={4}
              required
              value={config.camera_frames}
              onChange={(e) => update('camera_frames', Number(e.target.value))}
            />
          </label>
          <button className="primary-button" disabled={busy}>
            Сохранить сценарии
          </button>
        </form>
      )}
    </section>
  )
}
