import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'maplibre-gl/dist/maplibre-gl.css'
import './index.css'

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null }

  recover = () => {
    localStorage.removeItem('rit-screen')
    const separator = window.location.search ? '&' : '?'
    window.location.replace(`${window.location.pathname}${window.location.search}${separator}recover=${Date.now()}`)
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#F7F9FC', color: '#0D1B2A', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
        <div>
          <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>The app needs to reload</h1>
          <p style={{ margin: '0 0 18px', color: '#4A5568' }}>A temporary error stopped this screen from loading.</p>
          <button onClick={this.recover} style={{ border: 0, borderRadius: 10, padding: '12px 18px', background: '#1565C0', color: '#fff', fontWeight: 700 }}>Reload</button>
        </div>
      </main>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
)
