import { useEffect, useRef, useState } from 'react'

const API = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')

// A new session starts on every page load.
const newSessionId = () => 's-' + crypto.randomUUID().slice(0, 8)

const SIMULATIONS = ['', 'key_1=429', 'key_1=500', 'key_1=429,key_2=500', '*=429']

const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)
const PROVIDERS = { groq: 'Groq', nvidia_nim: 'NVIDIA NIM', gemini: 'Gemini', openrouter: 'OpenRouter', openai: 'OpenAI' }
const provider = (model = '') => PROVIDERS[model.split('/')[0]] || model.split('/')[0]
const shortModel = (model = '') => model.split('/').slice(-1)[0]

// Models answer in Markdown. Render the common inline bits as React elements (no HTML injection);
// lists and line breaks already read fine thanks to `white-space: pre-wrap`.
function Rich({ text }) {
  const parts = text.replace(/^#{1,6}\s+/gm, '').split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/g)
  return parts.map((part, i) =>
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
  const [elapsed, setElapsed] = useState(0)
  const [health, setHealth] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [route, setRoute] = useState(null) // what the last request did, for the key-pool rail
  const [lastFirst, setLastFirst] = useState('') // first message of the previous chat, for the cache demo chip
  const liveLatencies = useRef([]) // live (non-cache) latencies on this page, for the cache comparison
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

  // Real client-side stopwatch while a request is in flight.
  useEffect(() => {
    if (!pending) return
    const start = performance.now()
    setElapsed(0)
    const t = setInterval(() => setElapsed(Math.round(performance.now() - start)), 100)
    return () => clearInterval(t)
  }, [pending])

  async function send(text = input.trim(), sim = simulate) {
    if (!text || pending) return
    if (text === input.trim()) setInput('')
    setMessages((m) => [...m, { role: 'user', content: text, time: now() }])
    setPending(true)
    setRoute({ kind: 'pending' })
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (sim) headers['X-Simulate-Failure'] = sim
      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId, message: text, ...(systemPrompt.trim() && { system_prompt: systemPrompt }) }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) {
        const md = body.metadata
        const cached = md.resolution_source === 'LLM_CACHE'
        const liveAvg = liveLatencies.current.length
          ? Math.round(liveLatencies.current.reduce((a, b) => a + b, 0) / liveLatencies.current.length)
          : null
        if (!cached) liveLatencies.current.push(md.latency_ms)
        setRoute({ kind: cached ? 'cache' : 'live', attempts: md.attempts || [], answered: md.key_id, simulated: !!sim })
        setMessages((m) => [...m, { role: 'assistant', content: body.reply, metadata: md, raw: body, liveAvg, time: now() }])
      } else {
        setRoute(res.status === 503 ? { kind: 'down' } : null)
        setMessages((m) => [...m, { role: 'error', content: errorText(res.status, body), status: res.status, time: now() }])
      }
    } catch {
      setRoute(null)
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
    const first = messages.find((m) => m.role === 'user')
    if (first) setLastFirst(first.content)
    setSessionId(newSessionId())
    setMessages([])
    setRoute(null)
  }

  const keys = health?.keys || []
  const k1 = provider(keys[0]?.model) || 'key_1'
  const maxTokens = Math.max(1, ...messages.filter((m) => m.metadata).map((m) => m.metadata.input_tokens + m.metadata.output_tokens))

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
          One question, two providers. If a key is rate-limited or down, the request drops to the next one, and a
          question Kite has answered before is replayed from cache.
        </p>
      </header>

      <Rail keys={keys} route={route} />

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
                <div className="bubble">Hey! Ask me anything, or try one of these:</div>
                <div className="starters">
                  {lastFirst && (
                    <button className="starter cache" onClick={() => send(lastFirst, '')}>
                      <b>Ask again</b> “{lastFirst.length > 40 ? lastFirst.slice(0, 40) + '…' : lastFirst}” <span>expect a cache hit</span>
                    </button>
                  )}
                  <button className="starter" onClick={() => send('Explain what an API rate limit is in two sentences.', '')}>
                    <b>Ask</b> what an API rate limit is
                  </button>
                  <button className="starter warn" onClick={() => send('Give me one fun fact about kites.', 'key_1=429')}>
                    <b>Simulate a {k1} outage</b> <span>key_1=429</span>
                  </button>
                  <button className="starter bad" onClick={() => send('Hello!', '*=429')}>
                    <b>Simulate a total outage</b> <span>*=429</span>
                  </button>
                </div>
                {!lastFirst && <span className="time">Tip: after a reply, start a New chat and send the same first message.</span>}
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
              <AssistantMessage key={i} m={m} maxTokens={maxTokens} />
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
                <div className="bubble typing" aria-label="Kite is typing">
                  <i /><i /><i />
                  <span className="clock">{secs(elapsed)}</span>
                </div>
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
          <button data-testid="send-button" onClick={() => send()} disabled={pending || !input.trim()}>
            Send <SendIcon />
          </button>
        </div>
      </section>
    </div>
  )
}

function AssistantMessage({ m, maxTokens }) {
  const [inspect, setInspect] = useState(false)
  const md = m.metadata
  const cached = md.resolution_source === 'LLM_CACHE'
  const attempts = md.attempts || []
  return (
    <div className="row bot" data-testid="assistant-message">
      <BotAvatar />
      <div className="stack">
        {cached && (
          <span className="replay">
            <BoltIcon /> replayed from cache in {md.latency_ms} ms
            {m.liveAvg != null ? ` · live replies on this page average ${secs(m.liveAvg)}` : ''}
          </span>
        )}
        <div className={`bubble ${cached ? 'cached' : ''}`}><Rich text={m.content} /></div>

        <div className="trace" aria-label="Request path">
          {cached ? (
            <span className="hop cache">cache ✓</span>
          ) : (
            <>
              {attempts.map((a) => (
                <span key={a.key_id} className="hop-wrap">
                  <span className="hop fail" title={a.error}>{a.key_id} ✕ {a.status ?? a.error}</span>
                  <span className="arrow" aria-hidden="true">→</span>
                </span>
              ))}
              <span className="hop ok">{md.key_id} ✓</span>
            </>
          )}
        </div>

        <dl className="meta">
          <div className={`chip ${cached ? 'cache' : 'live'}`}><dt>source</dt><dd data-testid="meta-source">{md.resolution_source}</dd></div>
          <div className="chip"><dt>model</dt><dd data-testid="meta-model">{md.model}</dd></div>
          <div className="chip"><dt>latency</dt><dd data-testid="meta-latency">{md.latency_ms} ms</dd></div>
          <div className="chip"><dt>in</dt><dd data-testid="meta-input-tokens">{md.input_tokens}</dd></div>
          <div className="chip"><dt>out</dt><dd data-testid="meta-output-tokens">{md.output_tokens}</dd></div>
        </dl>

        <div className="tokbar" title={`This request only: ${md.input_tokens} in, ${md.output_tokens} out`}>
          <span className="in" style={{ width: `${(md.input_tokens / maxTokens) * 100}%` }} />
          <span className="out" style={{ width: `${(md.output_tokens / maxTokens) * 100}%` }} />
        </div>

        <div className="foot">
          <span className="time">{m.time}</span>
          <button className="inspect" onClick={() => setInspect((v) => !v)} aria-expanded={inspect}>
            {inspect ? 'hide JSON' : '{ } inspect'}
          </button>
        </div>
        {inspect && <pre className="json">{JSON.stringify(m.raw, null, 2)}</pre>}
      </div>
    </div>
  )
}

/* The key pool as a kite string: cache first, then each key in failover order. */
function Rail({ keys, route }) {
  if (!keys.length) return null
  const failed = new Map((route?.attempts || []).map((a) => [a.key_id, a.status ?? a.error]))
  const cacheState =
    route?.kind === 'cache' ? 'hit' : route?.kind === 'live' ? (route.simulated ? 'skip' : 'miss') : route?.kind === 'down' ? 'skip' : ''
  const keyState = (id) =>
    route?.kind === 'down' ? 'fail'
    : route?.kind !== 'live' ? ''
    : failed.has(id) ? 'fail'
    : route.answered === id ? 'ok'
    : ''
  const caption = {
    pending: 'request in flight…',
    cache: 'answered from cache, no key used',
    live: route?.attempts?.length ? `${route.attempts.length} key failed, ${route?.answered} answered` : `${route?.answered} answered`,
    down: 'every key failed (503)',
  }[route?.kind] || 'waiting for a message'

  return (
    <aside className={`rail ${route?.kind === 'pending' ? 'busy' : ''}`} aria-label="Key pool status">
      <span className="rail-title">key pool</span>
      <div className="nodes">
        <Node state={cacheState} label="cache" sub={cacheState === 'skip' ? 'skipped' : cacheState === 'miss' ? 'miss' : cacheState === 'hit' ? 'hit' : 'in-memory'} />
        {keys.map((k) => (
          <Node
            key={k.key_id}
            state={keyState(k.key_id)}
            label={k.key_id}
            sub={keyState(k.key_id) === 'fail' && failed.get(k.key_id) ? `✕ ${failed.get(k.key_id)}` : `${provider(k.model)} · ${shortModel(k.model)}`}
          />
        ))}
      </div>
      <span className="rail-caption">{caption}</span>
    </aside>
  )
}

function Node({ state, label, sub }) {
  return (
    <div className={`node ${state}`}>
      <span className="dot" />
      <span className="node-text">
        <b>{label}</b>
        <small>{sub}</small>
      </span>
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

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
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
