import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Ban,
  Check,
  ChevronLeft,
  Clock3,
  Compass,
  Flag,
  Headphones,
  Languages,
  LockKeyhole,
  MapPin,
  Mic2,
  MicOff,
  PhoneOff,
  RadioTower,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import { formatLocalTime, signals, type Signal } from './data'
import { useMicrophone } from './useMicrophone'

const WorldPicker = lazy(() => import('./WorldPicker').then((module) => ({ default: module.WorldPicker })))
const HeroGlobe = lazy(() => import('./WorldPicker').then((module) => ({ default: module.HeroGlobe })))

class WorldPickerBoundary extends Component<{ children: React.ReactNode; fallback?: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.warn('[world receiver unavailable]', error)
  }

  render() {
    if (this.state.failed) {
      return this.props.fallback ?? <div className="globe-loading globe-loading--error"><Compass size={34} /><p>The visual receiver is unavailable. Use the porch-light buttons to choose a live country.</p></div>
    }
    return this.props.children
  }
}

type Screen =
  | 'landing'
  | 'promise'
  | 'destination'
  | 'compose'
  | 'searching'
  | 'no_match'
  | 'match'
  | 'mic'
  | 'connecting'
  | 'call'
  | 'after'

type Intent = {
  name: string
  mood: string
  topic: string
  duration: number
  language: string
  destination: string
}

const moods = ['A little company', 'A thoughtful question', 'Trade stories']
const durations = [15, 20, 30]

function StepNumber({ step }: { step: number }) {
  return (
    <div className="screen-number">
      <span aria-hidden="true">0{step} / 04</span>
      <span className="visually-hidden">Step {step} of 4</span>
    </div>
  )
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
        <circle cx="15" cy="15" r="12.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M7.5 19.5 C 12 10.5, 18 9, 23.4 12.2" stroke="#ff6d52" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="7.5" cy="19.5" r="2.6" fill="#ffc966" />
        <circle cx="23.4" cy="12.2" r="2.6" fill="#33c9c1" />
      </svg>
    </span>
  )
}

function JourneyFrame({
  title,
  children,
  className = '',
  right,
}: {
  title: string
  children: React.ReactNode
  className?: string
  right?: React.ReactNode
}) {
  return (
    <section className={`journey-frame ${className}`}>
      <div className="frame-meta">
        <div className="frame-title">
          <span className="frame-dot" />
          {title}
        </div>
        <div className="frame-right">
          {right}
        </div>
      </div>
      {children}
    </section>
  )
}

function SignalAvatar({ signal, large = false }: { signal: Signal; large?: boolean }) {
  return (
    <span className={`signal-avatar ${large ? 'signal-avatar--large' : ''}`} style={{ '--avatar-color': signal.color } as React.CSSProperties} aria-hidden="true">
      <span>{signal.name.slice(0, 1)}</span>
      <i />
    </span>
  )
}

function WaveBars({ level = 0.32, remote = false }: { level?: number; remote?: boolean }) {
  return (
    <div className={`wave-bars ${remote ? 'wave-bars--remote' : ''}`} aria-hidden="true">
      {Array.from({ length: 13 }, (_, index) => {
        const shape = [0.35, 0.65, 0.48, 0.9, 0.58, 1, 0.72, 0.42, 0.8, 0.55, 0.95, 0.62, 0.38][index]
        return (
          <i
            key={index}
            style={{
              '--bar-height': `${Math.max(16, shape * (remote ? 78 : 24 + level * 66))}%`,
              '--bar-delay': `${index * -0.11}s`,
            } as React.CSSProperties}
          />
        )
      })}
    </div>
  )
}

function SignalBloom({ displaySignals }: { displaySignals: Signal[] }) {
  return (
    <div className="signal-bloom" role="img" aria-label={`Looking for one compatible conversation among ${displaySignals.length === 1 ? '1 open signal' : `${displaySignals.length} open signals`}`}>
      <span className="signal-bloom__ring signal-bloom__ring--one" aria-hidden="true" />
      <span className="signal-bloom__ring signal-bloom__ring--two" aria-hidden="true" />
      <span className="signal-bloom__core" aria-hidden="true"><Headphones size={27} /></span>
      {displaySignals.slice(0, 5).map((signal, index) => (
        <i key={signal.id} style={{ '--signal-color': signal.color, '--signal-index': index } as React.CSSProperties} aria-hidden="true" />
      ))}
    </div>
  )
}

function SafetyPanel({
  open,
  inCall,
  onClose,
  onLeave,
  onReport,
  onBlock,
}: {
  open: boolean
  inCall: boolean
  onClose: () => void
  onLeave: () => void
  onReport: () => void
  onBlock: () => void
}) {
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const leaveButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    const backdrop = backdropRef.current
    const siblings = backdrop?.parentElement
      ? Array.from(backdrop.parentElement.children).filter((element) => element !== backdrop && element instanceof HTMLElement) as HTMLElement[]
      : []
    const siblingState = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }))

    document.body.style.overflow = 'hidden'
    siblings.forEach((element) => {
      element.inert = true
      element.setAttribute('aria-hidden', 'true')
    })

    const focusFrame = window.requestAnimationFrame(() => {
      ;(leaveButtonRef.current ?? closeButtonRef.current)?.focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return

      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      siblingState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
      })
      previousFocus?.focus()
    }
  }, [open, inCall])

  if (!open) return null
  return (
    <div ref={backdropRef} className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <aside ref={panelRef} className="safety-panel" role="dialog" aria-modal="true" aria-labelledby="safety-title" aria-describedby="safety-description" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-bar">
          <span>Elsewhere · Trust &amp; safety</span>
          <button ref={closeButtonRef} className="icon-button" onClick={onClose} aria-label="Close safety panel"><X size={18} /></button>
        </div>
        <div className="safety-panel__body">
          <span className="eyebrow">A human-sized network</span>
          <h2 id="safety-title">The line is yours to close.</h2>
          <p id="safety-description" className="panel-lede">You can end any conversation immediately. You never owe a stranger your time, identity, or an explanation.</p>

          {inCall && (
            <div className="safety-actions">
              <button ref={leaveButtonRef} className="button button--danger" onClick={onLeave}><PhoneOff size={17} /> Leave now</button>
              <button className="button button--secondary" onClick={onReport}><Flag size={17} /> Leave &amp; report</button>
              <button className="text-action" onClick={onBlock}><Ban size={15} /> Block this person</button>
            </div>
          )}

          <div className="safety-grid">
            <div><span>01</span><strong>Audio only</strong><p>No cameras, images, links, or attachments.</p></div>
            <div><span>02</span><strong>Both people choose</strong><p>Nobody is dropped into a call with a stranger.</p></div>
            <div><span>03</span><strong>Calls have an ending</strong><p>Every line closes on time unless both people extend it.</p></div>
            <div><span>04</span><strong>No public score</strong><p>Feedback protects the room. It never becomes popularity.</p></div>
          </div>
          <div className="privacy-note"><LockKeyhole size={17} /><p><strong>Keep details general.</strong> Elsewhere does not record calls. Someone could still record from their own device, so avoid sharing identifying information.</p></div>
        </div>
      </aside>
    </div>
  )
}

function Landing({ availableSignals, onStart }: { availableSignals: Signal[]; onStart: () => void }) {
  const liveCountries = useMemo(() => availableSignals.map((signal) => signal.location), [availableSignals])

  return (
    <main className="page page--landing">
      <section className="hero-window">
        <div className="hero-grid">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-led" /> Someone interesting is awake</div>
            <h1>Talk to someone <em>outside your usual world.</em></h1>
            <p className="hero-lede">One audio-only conversation with a person somewhere else. No profiles to perform, no audience to impress, and no feed waiting afterward.</p>
            <div className="hero-actions">
              <button className="button button--primary button--large" onClick={onStart}>I’m available to talk <ArrowRight size={18} /></button>
              <span className="fine-print">You both choose. Leave anytime.</span>
            </div>
            <div className="hero-trust" aria-label="Elsewhere basics"><span><Headphones size={16} /> Audio only</span><span><ShieldCheck size={16} /> 18+</span><span><Clock3 size={16} /> Calls end on time</span></div>
          </div>
          <div className="hero-visual">
            <WorldPickerBoundary fallback={<div className="hero-globe-loading hero-globe-loading--error"><Compass size={30} /><p>The globe is resting. The open conversations below are still here.</p></div>}>
              <Suspense fallback={<div className="hero-globe-loading"><span /><p>Bringing the world into view…</p></div>}>
                <HeroGlobe availableCountries={liveCountries} />
              </Suspense>
            </WorldPickerBoundary>
          </div>
        </div>
      </section>

      <section className="transmissions" aria-labelledby="transmissions-title">
        <div className="section-heading">
          <div><span className="eyebrow">People open to a conversation</span><h2 id="transmissions-title">Elsewhere, right now</h2></div>
          <p>Not profiles to browse. Just a glimpse of what someone hopes to talk about.</p>
        </div>
        <div className="transmission-grid">
          {availableSignals.slice(0, 3).map((signal) => (
            <article className="transmission-card" key={signal.id}>
              <div className="transmission-meta"><span style={{ background: signal.color }} /><strong>{signal.location}</strong><i aria-hidden="true">·</i>{formatLocalTime(signal.timeZone)} there</div>
              <blockquote>“{signal.topic}”</blockquote>
              <div className="transmission-foot"><span>{signal.mood}</span><span>{signal.duration} min</span></div>
            </article>
          ))}
          {availableSignals.length === 0 && <article className="transmission-card transmission-card--quiet"><blockquote>“The receiver is quiet for this demo session.”</blockquote><div className="transmission-foot"><span>Blocked signals stay gone</span></div></article>}
        </div>
      </section>

      <section className="anti-feed">
        <div className="anti-feed__label"><Sparkles size={20} /> Why it feels different</div>
        <div className="anti-feed__copy">
          <h2>Nothing to post. <em>Nothing to perform.</em></h2>
          <p>Elsewhere is designed for one present-tense encounter—not collecting followers, building a personal brand, or keeping you online.</p>
        </div>
        <div className="anti-feed__marquee" aria-label="Product principles">
          <span>No video</span><i aria-hidden="true">✦</i><span>No swiping</span><i aria-hidden="true">✦</i><span>No DMs</span><i aria-hidden="true">✦</i><span>No followers</span><i aria-hidden="true">✦</i><span>No feed</span>
        </div>
      </section>
    </main>
  )
}

function PromiseScreen({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  return (
    <main className="page page--centered">
      <JourneyFrame title="Before you begin" className="flow-window">
        <div className="flow-body promise-body">
          <button className="back-link" onClick={onBack}><ChevronLeft size={16} /> Back</button>
          <StepNumber step={1} />
          <span className="eyebrow">The promise</span>
          <h1>This is a place for human conversation.</h1>
          <p className="flow-lede">Not flirting, sexual content, selling, or therapy. You and the person on the other end both agree to three simple things.</p>

          <div className="promise-list">
            <div><span>01</span><div><strong>Be curious.</strong><p>Meet the person, not a demographic or a profile.</p></div></div>
            <div><span>02</span><div><strong>Keep details general.</strong><p>No handles, contact information, or pressure to identify yourself.</p></div></div>
            <div><span>03</span><div><strong>Leave gracefully.</strong><p>Either person can close the line at any time, for any reason.</p></div></div>
          </div>

          <button className="button button--primary button--wide" onClick={onContinue}>I’m here to talk <ArrowRight size={18} /></button>
          <p className="agreement-copy">Continuing means you are 18 or older and agree to the Elsewhere promise.</p>
        </div>
      </JourneyFrame>
    </main>
  )
}

function DestinationScreen({
  destination,
  availableSignals,
  onSelect,
  onBack,
  onContinue,
}: {
  destination: string
  availableSignals: Signal[]
  onSelect: (country: string) => void
  onBack: () => void
  onContinue: () => void
}) {
  const liveCountries = useMemo(() => availableSignals.map((signal) => signal.location), [availableSignals])
  const hasLiveSignal = destination === 'Anywhere' || liveCountries.some((country) => country === destination)
  const selectedSignal = availableSignals.find((signal) => signal.location === destination)

  return (
    <main className="page page--centered destination-page">
      <JourneyFrame title="Choose a direction" className="destination-window">
        <div className="destination-layout">
          <div className="destination-copy">
            <button className="back-link" onClick={onBack}><ChevronLeft size={16} /> Back</button>
            <StepNumber step={2} />
            <span className="eyebrow">Step outside your orbit</span>
            <h1>Where in the world would you like to reach?</h1>
            <p>Pick a place, not a person. We’ll look for one compatible porch light there without turning people into a catalog.</p>

            <button className={`anywhere-card ${destination === 'Anywhere' ? 'is-selected' : ''}`} aria-pressed={destination === 'Anywhere'} onClick={() => onSelect('Anywhere')}>
              <Compass size={20} />
              <span><strong>Surprise me</strong><small>Anywhere beyond my usual world</small></span>
              <i aria-hidden="true">{destination === 'Anywhere' ? '●' : '○'}</i>
            </button>

            <div className="available-strip">
              <span>Porch lights on now</span>
              <div>{liveCountries.map((country) => <button className={destination === country ? 'is-selected' : ''} aria-pressed={destination === country} key={country} onClick={() => onSelect(country)}>{country}</button>)}</div>
            </div>

            <div className={`country-readout ${hasLiveSignal ? 'is-live' : 'is-quiet'}`}>
              <MapPin size={18} />
              <div>
                <span>{destination === 'Anywhere' ? 'The whole world' : destination}</span>
                <p>{destination === 'Anywhere' ? 'We’ll choose somewhere with an open signal.' : selectedSignal ? `${selectedSignal.name} has a ${selectedSignal.duration}-minute signal in the air.` : 'No open porch lights here in this demo. Try a glowing country.'}</p>
              </div>
            </div>

            <button className="button button--primary button--wide" disabled={!hasLiveSignal} onClick={onContinue}>
              {destination === 'Anywhere' ? 'Let the world surprise me' : `Reach toward ${destination}`} <ArrowRight size={18} />
            </button>
          </div>

          <div className="destination-globe">
            <WorldPickerBoundary>
              <Suspense fallback={<div className="globe-loading"><span /><p>Bringing the globe into view…</p></div>}>
                <WorldPicker selected={destination} availableCountries={liveCountries} onSelect={onSelect} />
              </Suspense>
            </WorldPickerBoundary>
            <div className="shell-caption"><span>A small step outward</span><p>Drag the globe, then choose a place that feels a little beyond your usual orbit.</p></div>
          </div>
        </div>
      </JourneyFrame>
    </main>
  )
}

function ComposeScreen({
  intent,
  setIntent,
  onBack,
  onSubmit,
}: {
  intent: Intent
  setIntent: React.Dispatch<React.SetStateAction<Intent>>
  onBack: () => void
  onSubmit: () => void
}) {
  const canSubmit = intent.name.trim().length > 0 && intent.topic.trim().length >= 8
  return (
    <main className="page page--centered">
      <JourneyFrame title="Set the tone" className="flow-window flow-window--wide">
        <form className="flow-body composer" onSubmit={(event) => { event.preventDefault(); if (canSubmit) onSubmit() }}>
          <button type="button" className="back-link" onClick={onBack}><ChevronLeft size={16} /> Back</button>
          <StepNumber step={3} />
          <span className="eyebrow">A little about tonight</span>
          <h1>What kind of conversation would feel good?</h1>

          <div className="form-grid">
            <label className="field">
              <span>Display name</span>
              <input value={intent.name} maxLength={20} onChange={(event) => setIntent((current) => ({ ...current, name: event.target.value }))} placeholder="First name or nickname" />
            </label>
            <label className="field">
              <span>Language</span>
              <select value={intent.language} onChange={(event) => setIntent((current) => ({ ...current, language: event.target.value }))}>
                <option>English</option><option>Spanish</option><option>French</option><option>Portuguese</option><option>Japanese</option>
              </select>
            </label>
          </div>

          <fieldset className="field-group">
            <legend>Tonight, I’m looking for…</legend>
            <div className="choice-row">
              {moods.map((mood) => <button type="button" key={mood} aria-pressed={intent.mood === mood} className={`choice-chip ${intent.mood === mood ? 'is-selected' : ''}`} onClick={() => setIntent((current) => ({ ...current, mood }))}><span className="radio-dot" />{mood}</button>)}
            </div>
          </fieldset>

          <div className="field field--topic">
            <label htmlFor="topic-input"><span>What would be good to talk about?</span></label>
            <textarea id="topic-input" aria-describedby="topic-hint" value={intent.topic} maxLength={120} onChange={(event) => setIntent((current) => ({ ...current, topic: event.target.value }))} placeholder="A question, a story, or something on your mind…" />
            <small id="topic-hint"><span>Keep names, handles, and contact details out.</span><b aria-hidden="true">{intent.topic.length}/120</b></small>
          </div>

          <fieldset className="field-group field-group--duration">
            <legend>How much time do you have?</legend>
            <div className="choice-row choice-row--duration">
              {durations.map((duration) => <button type="button" key={duration} aria-pressed={intent.duration === duration} className={`choice-chip choice-chip--time ${intent.duration === duration ? 'is-selected' : ''}`} onClick={() => setIntent((current) => ({ ...current, duration }))}><Clock3 size={15} />{duration} min</button>)}
            </div>
          </fieldset>

          <button className="button button--primary button--wide" disabled={!canSubmit}>See who else is awake <ArrowRight size={18} /></button>
        </form>
      </JourneyFrame>
    </main>
  )
}

function SearchingScreen({ intent, availableSignals, onCancel }: { intent: Intent; availableSignals: Signal[]; onCancel: () => void }) {
  return (
    <main className="page page--centered">
      <JourneyFrame title="Finding a conversation" className="flow-window search-window">
        <div className="search-body">
          <StepNumber step={4} />
          <div className="search-dial"><SignalBloom displaySignals={availableSignals} /></div>
          <span className="eyebrow"><span className="eyebrow-led" /> Looking for a reply</span>
          <h1>Your porch light is on.</h1>
          <p>Listening {intent.destination === 'Anywhere' ? 'around the world' : `toward ${intent.destination}`} for one person who wants <strong>{intent.mood.toLowerCase()}</strong> in {intent.language}.</p>
          <div className="search-status"><span /><span /><span /><b>Listening for one good fit</b></div>
          <button className="text-action" onClick={onCancel}>Take my signal down</button>
        </div>
      </JourneyFrame>
    </main>
  )
}

function NoMatchScreen({ intent, onAdjust, onChoosePlace }: { intent: Intent; onAdjust: () => void; onChoosePlace: () => void }) {
  return (
    <main className="page page--centered">
      <JourneyFrame title="No line yet" className="flow-window search-window">
        <div className="flow-body match-body">
          <div className="mic-icon"><RadioTower size={27} /></div>
          <span className="eyebrow">No exact reply yet</span>
          <h1>No exact match is awake right now.</h1>
          <p className="flow-lede">We couldn’t find someone {intent.destination === 'Anywhere' ? 'elsewhere' : `in ${intent.destination}`} who matches both <strong>{intent.language}</strong> and <strong>{intent.mood.toLowerCase()}</strong>. We won’t substitute a person who asked for something different.</p>
          <div className="mutual-note"><Clock3 size={20} /><p>Porch lights expire. A compatible signal may appear later, or you can gently widen what you’re listening for.</p></div>
          <div className="match-actions">
            <button className="button button--primary button--large" onClick={onAdjust}>Adjust my signal <ArrowRight size={18} /></button>
            <button className="button button--secondary" onClick={onChoosePlace}>Choose another place</button>
          </div>
        </div>
      </JourneyFrame>
    </main>
  )
}

function MatchScreen({ signal, intent, onAccept, onPass }: { signal: Signal; intent: Intent; onAccept: () => void; onPass: () => void }) {
  return (
    <main className="page page--centered">
      <JourneyFrame title="Someone answered" className="flow-window match-window" right={<span className="incoming-tag">A possible fit</span>}>
        <div className="flow-body match-body">
          <span className="eyebrow">Someone answered</span>
          <h1>{signal.name} is also looking for a real conversation.</h1>

          <div className="match-card">
            <SignalAvatar signal={signal} large />
            <div className="match-identity"><strong>{signal.name}</strong><span>{signal.location} · {formatLocalTime(signal.timeZone)} there</span></div>
            <div className="match-details">
              <span><Languages size={15} />{signal.language}</span><span><Clock3 size={15} />{Math.min(intent.duration, signal.duration)} minutes</span><span><Headphones size={15} />Audio only</span>
            </div>
            <blockquote>“{signal.topic}”</blockquote>
          </div>

          <div className="mutual-note"><ShieldCheck size={20} /><p><strong>Both people choose.</strong> Passing is private. {signal.name} will only know if you open the line.</p></div>
          <div className="match-actions"><button className="button button--primary button--large" onClick={onAccept}>Open the line <ArrowRight size={18} /></button><button className="button button--secondary" onClick={onPass}>Not tonight</button></div>
        </div>
      </JourneyFrame>
    </main>
  )
}

function MicScreen({ signal, microphone, onBack, onContinue }: { signal: Signal; microphone: ReturnType<typeof useMicrophone>; onBack: () => void; onContinue: () => void }) {
  const isReady = microphone.status === 'ready'
  return (
    <main className="page page--centered">
      <JourneyFrame title="Sound check" className="flow-window mic-window">
        <div className="flow-body mic-body">
          <button className="back-link" onClick={onBack}><ChevronLeft size={16} /> Back</button>
          <div className="mic-icon"><Mic2 size={27} /></div>
          <span className="eyebrow">Before the line opens</span>
          <h1>Let’s make sure we can hear you.</h1>
          <p className="flow-lede">Your browser will ask for microphone access. Elsewhere is audio-only—there is no camera permission.</p>

          <div className={`mic-meter ${isReady ? 'is-live' : ''}`}>
            <span>Input</span><WaveBars level={isReady ? microphone.level : 0.1} /><b>{isReady ? 'Ready' : 'Standby'}</b>
          </div>
          {microphone.error && <div className="form-error" role="alert">{microphone.error}</div>}
          {!isReady ? (
            <button className="button button--primary button--wide" onClick={() => void microphone.start()} disabled={microphone.status === 'requesting'}>
              {microphone.status === 'requesting' ? 'Waiting for permission…' : 'Check my microphone'} <Mic2 size={18} />
            </button>
          ) : (
            <button className="button button--primary button--wide" onClick={onContinue}>I’m ready to talk with {signal.name} <ArrowRight size={18} /></button>
          )}
          <div className="prototype-note"><Sparkles size={16} /><p><strong>Prototype note:</strong> the meter is genuinely using your local microphone. For this first build, the person and connection are simulated; your audio never leaves this device.</p></div>
        </div>
      </JourneyFrame>
    </main>
  )
}

function ConnectingScreen({ signal }: { signal: Signal }) {
  return (
    <main className="page page--centered page--call">
      <div className="connecting">
        <div className="connecting-people" aria-hidden="true">
          <span className="you-avatar">Y</span><div className="connecting-line"><i /><i /><i /><i /><i /></div><SignalAvatar signal={signal} large />
        </div>
        <span className="eyebrow">Opening the line</span>
        <h1>Connecting you and {signal.name}…</h1>
        <p>Audio only · either person can leave at any time</p>
      </div>
    </main>
  )
}

const formatTimer = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

function CallScreen({
  signal,
  intent,
  elapsed,
  microphone,
  onEnd,
  onSafety,
}: {
  signal: Signal
  intent: Intent
  elapsed: number
  microphone: ReturnType<typeof useMicrophone>
  onEnd: () => void
  onSafety: () => void
}) {
  const total = Math.min(intent.duration, signal.duration) * 60
  return (
    <main className="call-room">
      <h1 className="visually-hidden">The line with {signal.name} is open</h1>
      <div className="call-topline">
        <div className="live-chip"><i /> Line open</div>
        <div className="call-clock"><b>{formatTimer(Math.max(0, total - elapsed))}</b><span>left</span></div>
        <button className="safety-link" onClick={onSafety}><ShieldCheck size={16} /> Safety &amp; leave</button>
      </div>
      <div className="call-stage">
        <div className="call-person remote-person">
          <SignalAvatar signal={signal} large />
          <div className="person-copy"><span>On the other end</span><h2>{signal.name}</h2><p>{signal.location} · {formatLocalTime(signal.timeZone)}</p></div>
          <WaveBars remote />
        </div>
        <div className="call-divider"><i /><span>{formatTimer(elapsed)}</span><i /></div>
        <div className="call-person local-person">
          <span className="you-avatar you-avatar--large" aria-hidden="true">{intent.name.slice(0, 1).toUpperCase()}</span>
          <div className="person-copy"><span>You</span><h2>{intent.name}</h2><p>{microphone.muted ? 'Microphone muted' : 'Microphone on'}</p></div>
          <WaveBars level={microphone.muted ? 0 : microphone.level} />
        </div>
      </div>
      <div className="prompt-card"><span>If you need a place to begin</span><p>“{signal.topic}”</p></div>
      <div className="call-controls">
        <button className={`call-button ${microphone.muted ? 'is-active' : ''}`} onClick={microphone.toggleMute}>{microphone.muted ? <MicOff /> : <Mic2 />}<span>{microphone.muted ? 'Unmute' : 'Mute'}</span></button>
        <button className="call-button call-button--end" onClick={onEnd}><PhoneOff /><span>End</span></button>
      </div>
      <p className="call-reassurance">You can leave at any time. You don’t owe an explanation.</p>
    </main>
  )
}

function AfterScreen({
  signal,
  outcome,
  penPalRequested,
  elapsed,
  onOutcome,
  onPenPal,
  onReset,
  onReport,
}: {
  signal: Signal
  outcome: string
  penPalRequested: boolean
  elapsed: number
  onOutcome: (value: string) => void
  onPenPal: () => void
  onReset: () => void
  onReport: () => void
}) {
  const finished = outcome === 'good' || outcome === 'okay'
  const reported = outcome === 'reported' || outcome === 'blocked'
  return (
    <main className="page page--centered">
      <JourneyFrame title="After the conversation" className="flow-window after-window">
        <div className="flow-body after-body">
          {reported ? (
            <div className="after-thanks">
              <div className="after-icon"><ShieldCheck size={25} /></div>
              <span className="eyebrow">{outcome === 'blocked' ? 'Line blocked' : 'Demo report received'}</span>
              <h1>You won’t meet this person again in this session.</h1>
              <p>{outcome === 'blocked' ? 'This signal has been removed from your receiver.' : 'Thank you for telling us. The signal is blocked now; a real release would also place the account into moderation review.'}</p>
              <button className="button button--primary button--wide" onClick={onReset}>Return to the airwaves <RotateCcw size={17} /></button>
            </div>
          ) : !finished ? (
            <>
              <div className="after-icon"><Check size={25} /></div>
              <span className="eyebrow">The line is closed</span>
              <h1>How did that conversation feel?</h1>
              <p className="flow-lede">Your answer stays private. It helps Elsewhere protect the quality of future conversations.</p>
              <div className="feeling-list">
                <button onClick={() => onOutcome('good')}><span aria-hidden="true">✦</span><div><strong>Good &amp; genuine</strong><p>I’m glad we talked.</p></div><ArrowRight size={17} /></button>
                <button onClick={() => onOutcome('okay')}><span aria-hidden="true">○</span><div><strong>It was okay</strong><p>Nothing wrong, not quite a fit.</p></div><ArrowRight size={17} /></button>
                <button onClick={onReport}><span aria-hidden="true">!</span><div><strong>Uncomfortable</strong><p>I want to block or report this person.</p></div><ArrowRight size={17} /></button>
              </div>
            </>
          ) : (
            <div className="after-thanks">
              <div className="after-icon"><Check size={25} /></div>
              <span className="eyebrow">Signal received</span>
              <h1>Thanks for showing up.</h1>
              <p>For a little while, the world was smaller. Your private check-in has been saved for this demo session.</p>
              {outcome === 'good' && (
                <div className={`penpal-option ${penPalRequested ? 'is-sent' : ''}`}>
                  <RadioTower size={22} />
                  <div><strong>{penPalRequested ? 'Your half of the return signal is saved.' : `Could ${signal.name} become a voice pen pal?`}</strong><p>{penPalRequested ? `In a real release, the line would only reappear if ${signal.name} independently chooses it too. No direct messages.` : 'Keep the line available for another conversation. This only works if you both choose it independently.'}</p></div>
                  {!penPalRequested && <button className="button button--secondary" onClick={onPenPal}>Keep this line open</button>}
                </div>
              )}
              <div className="souvenir"><span>Elsewhere connection log</span><strong>{signal.location} ↔ you</strong><p>{new Date().toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' })} · {formatTimer(elapsed)} conversation</p><i>Not recorded by Elsewhere</i></div>
              <button className="button button--primary button--wide" onClick={onReset}>Return to the airwaves <RotateCcw size={17} /></button>
            </div>
          )}
        </div>
      </JourneyFrame>
    </main>
  )
}

function App() {
  const [screen, setScreen] = useState<Screen>('landing')
  const [safetyOpen, setSafetyOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [outcome, setOutcome] = useState('')
  const [penPalRequested, setPenPalRequested] = useState(false)
  const [blockedIds, setBlockedIds] = useState<Set<string>>(() => new Set())
  const [now, setNow] = useState(new Date())
  const [intent, setIntent] = useState<Intent>({
    name: '',
    mood: 'A little company',
    topic: '',
    duration: 20,
    language: 'English',
    destination: 'Anywhere',
  })
  const microphone = useMicrophone()
  const firstScreenRef = useRef(true)
  const safetyOpenRef = useRef(false)
  safetyOpenRef.current = safetyOpen
  const selectedSignal = signals[selectedIndex % signals.length]
  const inCall = screen === 'call'
  const availableSignals = useMemo(() => signals.filter((signal) => !blockedIds.has(signal.id)), [blockedIds])
  const matchingCandidates = useMemo(() => signals.filter((signal) => {
    const correctPlace = intent.destination === 'Anywhere' || signal.location === intent.destination
    const correctLanguage = signal.language.split(' · ').includes(intent.language)
    return correctPlace && correctLanguage && signal.mood === intent.mood && !blockedIds.has(signal.id)
  }), [blockedIds, intent.destination, intent.language, intent.mood])
  const totalCallSeconds = Math.min(intent.duration, selectedSignal.duration) * 60

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    // Hold the search while the safety panel is open so the screen never
    // swaps out from underneath an open modal (which would break its focus trap).
    if (screen !== 'searching' || safetyOpen) return
    const timer = window.setTimeout(() => {
      if (matchingCandidates.length === 0) {
        setScreen('no_match')
        return
      }
      const candidate = matchingCandidates[selectedIndex % matchingCandidates.length]
      setSelectedIndex(signals.findIndex((signal) => signal.id === candidate.id))
      setScreen('match')
    }, 3200)
    return () => window.clearTimeout(timer)
  }, [matchingCandidates, safetyOpen, screen, selectedIndex])

  useEffect(() => {
    if (screen !== 'connecting') return
    const timer = window.setTimeout(() => {
      setElapsed(0)
      setScreen('call')
    }, 2200)
    return () => window.clearTimeout(timer)
  }, [screen])

  useEffect(() => {
    if (screen !== 'call') return
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [screen])

  useEffect(() => {
    if (screen !== 'call' || elapsed < totalCallSeconds) return
    microphone.stop()
    setSafetyOpen(false)
    setScreen('after')
  }, [elapsed, microphone.stop, screen, totalCallSeconds])

  useEffect(() => {
    // Skip on first mount (don't steal focus from the top of the page) and
    // while the safety dialog is open (its own focus management is in charge).
    if (firstScreenRef.current) {
      firstScreenRef.current = false
      return
    }
    if (safetyOpenRef.current) return
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' })
    const focusFrame = window.requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>('main h1')
      if (!heading) return
      heading.setAttribute('tabindex', '-1')
      heading.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(focusFrame)
  }, [screen])

  const time = useMemo(() => now.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }), [now])

  const reset = () => {
    microphone.stop()
    setOutcome('')
    setPenPalRequested(false)
    setElapsed(0)
    setIntent({ name: '', mood: 'A little company', topic: '', duration: 20, language: 'English', destination: 'Anywhere' })
    setScreen('landing')
  }

  const beginSearch = () => {
    setScreen('searching')
  }

  const endCall = () => {
    microphone.stop()
    setSafetyOpen(false)
    setScreen('after')
  }

  const report = () => {
    microphone.stop()
    setSafetyOpen(false)
    setBlockedIds((current) => new Set(current).add(selectedSignal.id))
    setOutcome('reported')
    setScreen('after')
  }

  const block = () => {
    microphone.stop()
    setSafetyOpen(false)
    setBlockedIds((current) => new Set(current).add(selectedSignal.id))
    setOutcome('blocked')
    setScreen('after')
  }

  return (
    <div className={`app app--${screen}`}>
      <div className="visually-hidden" role="status">
        {screen === 'connecting' ? `Opening the line to ${selectedSignal.name}.` : screen === 'call' ? `Connected. Your conversation with ${selectedSignal.name} has begun.` : ''}
      </div>
      {screen !== 'call' && screen !== 'connecting' && (
        <header className="site-header">
          <button className="brand" onClick={reset} aria-label="Elsewhere home"><BrandMark /><span>Elsewhere</span></button>
          <div className="header-center"><span className="status-led" /> {availableSignals.length} {availableSignals.length === 1 ? 'person' : 'people'} open to a conversation <i aria-hidden="true">·</i> {time} where you are</div>
          <button className="header-safety" onClick={() => setSafetyOpen(true)}><ShieldCheck size={16} /> Safety &amp; privacy</button>
        </header>
      )}

      {screen === 'landing' && <Landing availableSignals={availableSignals} onStart={() => setScreen('promise')} />}
      {screen === 'promise' && <PromiseScreen onBack={() => setScreen('landing')} onContinue={() => setScreen('destination')} />}
      {screen === 'destination' && <DestinationScreen destination={intent.destination} availableSignals={availableSignals} onSelect={(destination) => setIntent((current) => ({ ...current, destination }))} onBack={() => setScreen('promise')} onContinue={() => setScreen('compose')} />}
      {screen === 'compose' && <ComposeScreen intent={intent} setIntent={setIntent} onBack={() => setScreen('destination')} onSubmit={beginSearch} />}
      {screen === 'searching' && <SearchingScreen intent={intent} availableSignals={availableSignals} onCancel={() => setScreen('compose')} />}
      {screen === 'no_match' && <NoMatchScreen intent={intent} onAdjust={() => setScreen('compose')} onChoosePlace={() => setScreen('destination')} />}
      {screen === 'match' && <MatchScreen signal={selectedSignal} intent={intent} onAccept={() => setScreen('mic')} onPass={() => setScreen('destination')} />}
      {screen === 'mic' && <MicScreen signal={selectedSignal} microphone={microphone} onBack={() => { microphone.stop(); setScreen('match') }} onContinue={() => setScreen('connecting')} />}
      {screen === 'connecting' && <ConnectingScreen signal={selectedSignal} />}
      {screen === 'call' && <CallScreen signal={selectedSignal} intent={intent} elapsed={elapsed} microphone={microphone} onEnd={endCall} onSafety={() => setSafetyOpen(true)} />}
      {screen === 'after' && <AfterScreen signal={selectedSignal} outcome={outcome} penPalRequested={penPalRequested} elapsed={elapsed} onOutcome={setOutcome} onPenPal={() => setPenPalRequested(true)} onReset={reset} onReport={report} />}

      <SafetyPanel open={safetyOpen} inCall={inCall} onClose={() => setSafetyOpen(false)} onLeave={endCall} onReport={report} onBlock={block} />

      {screen !== 'call' && screen !== 'connecting' && (
        <footer className="site-footer"><span>© Elsewhere</span><span>Audio only · adults only</span><span>One good conversation at a time</span></footer>
      )}
    </div>
  )
}

export default App
