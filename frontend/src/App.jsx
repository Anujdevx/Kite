import { useEffect, useRef, useState } from 'react'

const API = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')

// A new session starts on every page load.
const newSessionId = () => 's-' + crypto.randomUUID().slice(0, 8)

const SIMULATIONS = ['', 'key_1=429', 'key_1=500', 'key_1=429,key_2=500', '*=429']

const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()

// Models answer in Markdown. Render the common inline bits as React elements (no HTML injection);
// lists and line breaks already read fine thanks to `white-space: pre-wrap`.
function Rich({ text }) {
  const lines = text.replace(/^#{1,6}\s+/gm, '').split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/g)
  return lines.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code>
    : part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <em key={i}>{part.slice(1, -1)}</em>
    : part,
  )
}

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
  const [showSettings, setShowSettings] = useState(false)
  const logRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'down' }))
  }, [])

  // Keep the newest message in view (scrolls the chat panel, not the page).
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, pending])

  async function send() {
    const text = input.trim()
    if (!text || pending) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', content: text, time: now() }])
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
          ? { role: 'assistant', content: body.reply, metadata: body.metadata, time: now() }
          : { role: 'error', content: errorText(res.status, body), status: res.status, time: now() },
      ])
    } catch {
      setMessages((m) => [...m, { role: 'error', content: `Could not reach the backend at ${API}.`, time: now() }])
    } finally {
      setPending(false)
      inputRef.current?.focus()
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
    <div className="page">
      <div className="sky" aria-hidden="true" />

      <header className="hero">
        <div className="mark"><KiteIcon /></div>
        <h1>
          Ask <span className="grad">Kite</span>
          <br />
          anything
        </h1>
        <p>
          A multi-turn assistant that switches API keys when one fails and answers repeat questions from cache. Every reply
          shows its source, model, latency and tokens.
        </p>
      </header>

      <section className="panel">
        <div className="bar">
          <span className="session">
            session <code>{sessionId}</code>
          </span>
          <HealthBadge health={health} />
          <div className="bar-actions">
            <button className="ghost" onClick={resetSession} disabled={pending}>New chat</button>
            <button
              className={`ghost icon ${showSettings ? 'on' : ''}`}
              onClick={() => setShowSettings((s) => !s)}
              aria-expanded={showSettings}
              aria-label="Session settings"
              title="Session settings"
            >
              <GearIcon />
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="settings">
            <label>
              <span>System prompt <em>optional, for this session</em></span>
              <textarea
                data-testid="system-prompt-input"
                rows={2}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="You are a helpful, concise assistant."
              />
            </label>
            <label>
              <span>Failover test <em>sends X-Simulate-Failure with each message</em></span>
              <select value={simulate} onChange={(e) => setSimulate(e.target.value)}>
                {SIMULATIONS.map((s) => (
                  <option key={s} value={s}>{s || 'off'}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="log" ref={logRef} aria-live="polite">
          {messages.length === 0 && (
            <div className="row bot">
              <BotAvatar />
              <div className="stack">
                <div className="bubble">Hey! Ask me anything. Try the same first question in a new chat to see a cache hit.</div>
              </div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="row me">
                <div className="stack">
                  <div className="bubble">{m.content}</div>
                  <span className="time">{m.time}</span>
                </div>
                <div className="avatar me-avatar" aria-hidden="true">You</div>
              </div>
            ) : m.role === 'assistant' ? (
              <AssistantMessage key={i} m={m} />
            ) : (
              <div key={i} className="row bot" role="alert">
                <BotAvatar error />
                <div className="stack">
                  <div className="bubble error">
                    <strong>Error{m.status ? ` ${m.status}` : ''}</strong> {m.content}
                  </div>
                  <span className="time">{m.time}</span>
                </div>
              </div>
            ),
          )}
          {pending && (
            <div className="row bot">
              <BotAvatar />
              <div className="stack">
                <div className="bubble typing" aria-label="Kite is typing"><i /><i /><i /></div>
              </div>
            </div>
          )}
        </div>

        <div className="composer">
          <textarea
            ref={inputRef}
            data-testid="chat-input"
            rows={1}
            value={input}
            maxLength={4000}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Write a message"
            aria-label="Message"
          />
          <button data-testid="send-button" onClick={send} disabled={pending || !input.trim()}>
            Send <SendIcon />
          </button>
        </div>
      </section>
    </div>
  )
}

function AssistantMessage({ m }) {
  const md = m.metadata
  const cached = md.resolution_source === 'LLM_CACHE'
  return (
    <div className="row bot" data-testid="assistant-message">
      <BotAvatar />
      <div className="stack">
        <div className="bubble"><Rich text={m.content} /></div>
        <dl className="meta">
          <div className={`chip ${cached ? 'cache' : 'live'}`}><dt>source</dt><dd data-testid="meta-source">{md.resolution_source}</dd></div>
          <div className="chip"><dt>model</dt><dd data-testid="meta-model">{md.model}</dd></div>
          <div className="chip"><dt>latency</dt><dd data-testid="meta-latency">{md.latency_ms} ms</dd></div>
          <div className="chip"><dt>in</dt><dd data-testid="meta-input-tokens">{md.input_tokens}</dd></div>
          <div className="chip"><dt>out</dt><dd data-testid="meta-output-tokens">{md.output_tokens}</dd></div>
          <div className={`chip ${md.fallback_attempts > 0 ? 'warn' : ''}`}>
            <dt>key</dt>
            <dd>{md.key_id ?? '—'}{md.fallback_attempts > 0 && ` · after ${md.fallback_attempts} failed`}</dd>
          </div>
        </dl>
        <span className="time">{m.time}</span>
      </div>
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

function BotAvatar({ error }) {
  return (
    <div className={`avatar bot-avatar ${error ? 'err' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <rect x="4" y="7" width="16" height="12" rx="3" />
        <path d="M12 7V4M9 12v1.5M15 12v1.5M2 12v3M22 12v3" />
      </svg>
    </div>
  )
}

function KiteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M12 2l6 7-6 9-6-9z" fill="currentColor" fillOpacity=".18" />
      <path d="M6 9h12M12 2v16" />
      <path d="M12 18c-1 2 1 2.5 0 4" strokeLinecap="round" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M3.4 20.4l17.4-7.5a1 1 0 0 0 0-1.8L3.4 3.6a1 1 0 0 0-1.4 1.1L4 11l9 1-9 1-2 6.3a1 1 0 0 0 1.4 1.1z" />
    </svg>
  )
}
