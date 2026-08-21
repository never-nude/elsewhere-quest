import { useCallback, useEffect, useRef, useState } from 'react'

type MicrophoneStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable' | 'error'

const errorMessageFor = (error: unknown) => {
  if (!(error instanceof DOMException)) return 'We could not start your microphone. Please try again.'
  if (error.name === 'NotAllowedError') return 'Microphone access is off. Allow it in your browser settings, then try again.'
  if (error.name === 'NotFoundError') return 'We could not find a microphone on this device.'
  if (error.name === 'NotReadableError') return 'Your microphone may be in use by another app.'
  return 'We could not start your microphone. Please try again.'
}

const stopStream = (stream: MediaStream | null) => {
  stream?.getTracks().forEach((track) => track.stop())
}

const closeContext = (context: AudioContext | null) => {
  if (!context || context.state === 'closed') return
  void context.close().catch(() => undefined)
}

export function useMicrophone() {
  const [status, setStatus] = useState<MicrophoneStatus>('idle')
  const [error, setError] = useState('')
  const [level, setLevel] = useState(0)
  const [muted, setMuted] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const frameRef = useRef<number | null>(null)
  const attemptRef = useRef(0)
  const startPromiseRef = useRef<Promise<boolean> | null>(null)
  const mountedRef = useRef(true)

  const releaseActiveResources = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    stopStream(streamRef.current)
    streamRef.current = null
    closeContext(contextRef.current)
    contextRef.current = null
  }, [])

  const stop = useCallback(() => {
    attemptRef.current += 1
    startPromiseRef.current = null
    releaseActiveResources()
    if (!mountedRef.current) return
    setLevel(0)
    setMuted(false)
    setStatus('idle')
    setError('')
  }, [releaseActiveResources])

  const start = useCallback((): Promise<boolean> => {
    if (startPromiseRef.current) return startPromiseRef.current

    const activeStream = streamRef.current
    if (activeStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      return Promise.resolve(true)
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable')
      setError('Microphone access needs HTTPS or localhost in a supported browser.')
      return Promise.resolve(false)
    }

    releaseActiveResources()
    const attempt = ++attemptRef.current
    setStatus('requesting')
    setError('')
    let request: Promise<boolean>
    request = (async () => {
      let stream: MediaStream | null = null
      let context: AudioContext | null = null
      let source: MediaStreamAudioSourceNode | null = null
      let frame: number | null = null

      const isCurrent = () => mountedRef.current && attemptRef.current === attempt
      const cleanupAttempt = () => {
        if (frame !== null) cancelAnimationFrame(frame)
        if (frameRef.current === frame) frameRef.current = null
        try {
          source?.disconnect()
        } catch {
          // The source may never have connected if setup failed partway through.
        }
        if (streamRef.current === stream) streamRef.current = null
        if (contextRef.current === context) contextRef.current = null
        stopStream(stream)
        closeContext(context)
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        })
        if (!isCurrent()) {
          cleanupAttempt()
          return false
        }
        streamRef.current = stream

        context = new AudioContext()
        contextRef.current = context
        if (context.state === 'suspended') await context.resume()
        if (!isCurrent()) {
          cleanupAttempt()
          return false
        }

        source = context.createMediaStreamSource(stream)
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.78
        source.connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        let lastUpdate = 0

        const measure = (time: number) => {
          if (!isCurrent() || streamRef.current !== stream || contextRef.current !== context) return
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (const sample of samples) sum += sample * sample
          const rms = Math.sqrt(sum / samples.length)
          if (time - lastUpdate > 70) {
            setLevel(Math.min(1, rms * 7.5))
            lastUpdate = time
          }
          frame = requestAnimationFrame(measure)
          frameRef.current = frame
        }

        frame = requestAnimationFrame(measure)
        frameRef.current = frame
        setStatus('ready')
        return true
      } catch (caught) {
        cleanupAttempt()
        if (!isCurrent()) return false
        const denied = caught instanceof DOMException && caught.name === 'NotAllowedError'
        setStatus(denied ? 'denied' : 'error')
        setError(errorMessageFor(caught))
        return false
      }
    })()

    startPromiseRef.current = request
    void request.finally(() => {
      if (startPromiseRef.current === request) startPromiseRef.current = null
    })
    return request
  }, [releaseActiveResources])

  const toggleMute = useCallback(() => {
    const next = !muted
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next
    })
    setMuted(next)
    if (next) setLevel(0)
  }, [muted])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptRef.current += 1
      startPromiseRef.current = null
      releaseActiveResources()
    }
  }, [releaseActiveResources])

  return { status, error, level, muted, start, stop, toggleMute }
}
