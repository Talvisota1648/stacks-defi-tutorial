import { Component, ErrorInfo, ReactNode } from 'react'
export default class ReportBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    return this.state.failed ? (
      <main className="panel v2-section" role="alert">
        <h1>Не удалось отобразить страницу</h1>
        <p>
          Ошибка отображения не удаляет материалы на сервере. Вернитесь к
          мониторингу или перезагрузите страницу.
        </p>
        <a className="secondary-button" href="/">
          К мониторингу
        </a>
        <button
          className="secondary-button"
          onClick={() => window.location.reload()}
        >
          Перезагрузить
        </button>
      </main>
    ) : (
      this.props.children
    )
  }
}
