import type { RealtimeConnection } from '@elevenlabs/client'

/**
 * ElevenLabs realtime transcription without `useScribe`.
 *
 * The hook pulls the whole ElevenLabs client (~130 KB gzip) into whatever
 * renders the composer, though most people never dictate through
 * ElevenLabs. This keeps the same event wiring as `useScribe` but imports
 * the client only when a dictation actually starts.
 */
export type ElevenLabsScribeCallbacks = {
    onSessionStarted: () => void
    onPartialTranscript: (text: string) => void
    onCommittedTranscript: (text: string) => void
    onError: (error: Error) => void
    onDisconnect: () => void
}

export type ElevenLabsScribe = {
    connect: (options: {
        token: string
        modelId: string
        languageCode?: string
        microphone: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }
    }) => Promise<void>
    commit: () => void
    disconnect: () => void
}

export function createElevenLabsScribe(callbacks: () => ElevenLabsScribeCallbacks): ElevenLabsScribe {
    let connection: RealtimeConnection | null = null

    return {
        async connect(options) {
            if (connection) return
            const { Scribe, RealtimeEvents, CommitStrategy } = await import('@elevenlabs/client')
            const current = Scribe.connect({
                ...options,
                commitStrategy: CommitStrategy.MANUAL,
                includeTimestamps: false
            })
            connection = current
            current.on(RealtimeEvents.SESSION_STARTED, () => callbacks().onSessionStarted())
            current.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data: unknown) => {
                callbacks().onPartialTranscript((data as { text: string }).text)
            })
            current.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data: unknown) => {
                callbacks().onCommittedTranscript((data as { text: string }).text)
            })
            current.on(RealtimeEvents.ERROR, (data: unknown) => {
                callbacks().onError(new Error((data as { error?: string }).error ?? 'ElevenLabs transcription error'))
            })
            current.on(RealtimeEvents.CLOSE, () => {
                if (connection === current) connection = null
                callbacks().onDisconnect()
            })
        },
        commit() {
            if (!connection) throw new Error('Not connected to Scribe')
            connection.commit()
        },
        disconnect() {
            connection?.close()
            connection = null
        }
    }
}
