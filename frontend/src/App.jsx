import { useEffect, useRef, useState } from 'react'

const API = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')

// A new session starts on every page load.
const newSessionId = () => 's-' + crypto.randomUUID().slice(0, 8)

const SIMULATIONS = ['', 'key_1=429', 'key_1=500', 'key_1=429,key_2=500', '*=429']

function errorText(status, body) {
  const d = body?.detail
  if (status === 503) return 'All providers are unavailable right now (every API key failed). Nothing was saved; try again.'
  if (Array.isArray(d)) return d.map((e) => `${(e.loc || []).slice(1).join('.') || 'request'}: ${e.msg}`).join('; ')
  return typeof d === 'string' ? d : `Request failed (HTTP ${status}).`
}

export default function App() {
  const [sessionId, setSessionId] = useState(newSessionId)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [simulate, setSimulate] = useState('')
  const [pending, setPending] = useState(false)
  const [health, setHealth] = useState(null)
  const endRef = useRef(null)

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'down' }))
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, pending])

  async function send() {
    const text = input.trim()
    if (!text || pending) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', content: text }])
    setPending(true)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (simulate) headers['X-Simulate-Failure'] = simulate
      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId, message: text, ...(systemPrompt.trim() && { system_prompt: systemPrompt }) }),
      })
      const body = await res.json().catch(() => null)
      setMessages((m) => [
        ...m,
        res.ok
          ? { role: 'assistant', content: body.reply, metadata: body.metadata }
          : { role: 'error', content: errorText(res.status, body), status: res.status },
      ])
    } catch {
      setMessages((m) => [...m, { role: 'error', content: `Could not reach the backend at ${API}.` }])
    } finally {
      setPending(false)
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function resetSession() {
    setSessionId(newSessionId())
    setMessages([])
  }

  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>Lyftr Chat</h1>
          <p className="sub">
            session <code>{sessionId}</code>
            <button className="link" onClick={resetSession} disabled={pending}>new session</button>
          </p>
        </div>
        <HealthBadge health={health} />
      </header>

      <details className="settings">
        <summary>Session settings</summary>
        <label>
          System prompt <span className="hint">optional, applies to this session</span>
          <textarea
            data-testid="system-prompt-input"
            rows={2}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a helpful, concise assistant."
          />
        </label>
        <label>
          Failover test <span className="hint">sends X-Simulate-Failure with each message</span>
          <select value={simulate} onChange={(e) => setSimulate(e.target.value)}>
            {SIMULATIONS.map((s) => (
              <option key={s} value={s}>{s || 'off'}</option>
            ))}
          </select>
        </label>
      </details>

      <main className="log" aria-live="polite">
        {messages.length === 0 && <p className="empty">Ask anything. Each reply shows where it came from, which model and key answered, how long it took, and the tokens for that request alone.</p>}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="turn user">
              <span className="who">You</span>
              <p>{m.content}</p>
            </div>
          ) : m.role === 'assistant' ? (
            <AssistantMessage key={i} m={m} />
          ) : (
            <div key={i} className="turn error" role="alert">
              <span className="who">Error{m.status ? ` ${m.status}` : ''}</span>
              <p>{m.content}</p>
            </div>
          ),
        )}
        {pending && <div className="turn assistant pending"><span className="who">Assistant</span><p>…</p></div>}
        <div ref={endRef} />
      </main>

      <footer className="composer">
        <textarea
          data-testid="chat-input"
          rows={2}
          value={input}
          maxLength={4000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message (Enter to send, Shift+Enter for a new line)"
        />
        <button data-testid="send-button" onClick={send} disabled={pending || !input.trim()}>
          Send
        </button>
      </footer>
    </div>
  )
}

function AssistantMessage({ m }) {
  const md = m.metadata
  const cached = md.resolution_source === 'LLM_CACHE'
  return (
    <div className="turn assistant" data-testid="assistant-message">
      <span className="who">Assistant</span>
      <p>{m.content}</p>
      <dl className="meta">
        <div><dt>source</dt><dd data-testid="meta-source" className={cached ? 'cache' : 'live'}>{md.resolution_source}</dd></div>
        <div><dt>model</dt><dd data-testid="meta-model">{md.model}</dd></div>
        <div><dt>latency</dt><dd data-testid="meta-latency">{md.latency_ms} ms</dd></div>
        <div><dt>in</dt><dd data-testid="meta-input-tokens">{md.input_tokens}</dd></div>
        <div><dt>out</dt><dd data-testid="meta-output-tokens">{md.output_tokens}</dd></div>
        <div><dt>key</dt><dd>{md.key_id ?? '—'}{md.fallback_attempts > 0 && ` (after ${md.fallback_attempts} failed)`}</dd></div>
      </dl>
    </div>
  )
}

function HealthBadge({ health }) {
  if (!health) return <span className="badge">checking…</span>
  if (health.status !== 'ok') return <span className="badge down">backend unavailable</span>
  return (
    <span className="badge ok">
      {health.keys_configured} keys · cache {health.cache_enabled ? 'on' : 'off'}
    </span>
  )
}
