import { ASSISTANT_COMPACT_COMMAND, ASSISTANT_CURATE_MARKER, CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS, getClaudeContextWindowTokens } from '@hapi/protocol'
import type { Session, SyncEvent } from './syncEngine'

/**
 * Curate memory before the assistant's context is compacted.
 *
 * The assistant is one conversation that never ends, so compaction is where
 * detail is lost for good. Before it happens the assistant is asked to file
 * what is worth keeping; only once that turn is over is `/compact` sent. The
 * threshold sits well under Claude's own auto-compaction so the hub, not
 * Claude, decides when it happens. After it, the next message re-sends the
 * task context and memory index the compaction just summarised away.
 */

/** Share of the context window at which curation starts. */
const ASSISTANT_COMPACT_THRESHOLD = 0.7

/** `DUGONG_ASSISTANT_COMPACT_THRESHOLD` (0-1) overrides the default, for tuning and for trying it out. */
export function readCompactThreshold(env: NodeJS.ProcessEnv = process.env): number {
    const value = Number(env.DUGONG_ASSISTANT_COMPACT_THRESHOLD)
    return Number.isFinite(value) && value > 0 && value < 1 ? value : ASSISTANT_COMPACT_THRESHOLD
}

/**
 * agy reports a 1M window but compacts on its own somewhere below it (its
 * binary carries a 512k checkpoint limit). The hub must get there first, or
 * the memory pass never runs.
 */
const AGY_WINDOW_CAP = 512_000

/** Until a turn result reports the real window: the shared model table, else 200k. */
export function contextWindowFor(model: string | null | undefined): number {
    return getClaudeContextWindowTokens(model) ?? CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS
}

const CURATE_BEFORE_COMPACT_PROMPT = (percent: number) =>
    `${ASSISTANT_CURATE_MARKER} The context is about ${percent}% full and will be compacted next. ` +
    'Following your memory rules, go through the conversation since the last compaction: ' +
    'add or update memories for what is worth keeping (corrected approaches, preferences, decisions and their reasons, non-obvious constraints), ' +
    'and fix or delete entries that turned out wrong or stale. ' +
    'Do not copy the conversation itself into memory. When done, say in one sentence what you filed.'

type Phase = 'idle' | 'curating' | 'compacting'

export type AssistantCompactionDeps = {
    getSession: (sessionId: string) => Session | undefined
    send: (sessionId: string, text: string) => Promise<void>
    /** The compaction finished: the assistant no longer holds its context block. */
    onCompacted: (sessionId: string) => void
    logError?: (message: string) => void
    threshold?: number
}

export class AssistantCompaction {
    /** `window`: the context size Claude itself reported, when it has. */
    private readonly state = new Map<string, { tokens: number; phase: Phase; window?: number }>()
    /** Ready events still to come from turns the hub started itself. */
    private readonly quietReadies = new Map<string, number>()

    constructor(private readonly deps: AssistantCompactionDeps) {}

    /**
     * Should the `ready` that just arrived stay quiet? Called once per ready.
     * The count is set only after the curate prompt has gone out, so the
     * ready that ended the person's own turn -- the one that triggered all
     * this -- is never swallowed.
     */
    consumeQuietReady(sessionId: string): boolean {
        const remaining = this.quietReadies.get(sessionId) ?? 0
        if (remaining <= 0) return false
        if (remaining === 1) this.quietReadies.delete(sessionId)
        else this.quietReadies.set(sessionId, remaining - 1)
        return true
    }

    handle(event: SyncEvent): void {
        if (event.type !== 'message-received') return
        const session = this.deps.getSession(event.sessionId)
        if (session?.metadata?.role !== 'assistant') return

        const content = event.message.content as {
            role?: string
            content?: {
                type?: string
                data?: {
                    type?: string
                    message?: { usage?: Record<string, unknown> }
                    info?: Record<string, unknown>
                    resultSummary?: { modelUsage?: Record<string, { contextWindow?: unknown }> }
                }
            }
        } | null
        if (content?.role !== 'agent') return
        const entry: { tokens: number; phase: Phase; window?: number } = this.state.get(session.id) ?? { tokens: 0, phase: 'idle' }
        this.state.set(session.id, entry)

        // Each turn's result names the window of every model it used; the
        // largest is the main model's (the rest are small helpers).
        const modelUsage = content.content?.data?.resultSummary?.modelUsage
        if (modelUsage) {
            const windows = Object.values(modelUsage)
                .map((usage) => usage?.contextWindow)
                .filter((value): value is number => typeof value === 'number' && value > 0)
            if (windows.length > 0) entry.window = Math.max(...windows)
        }

        const usage = content.content?.type === 'output' && content.content.data?.type === 'assistant'
            ? content.content.data.message?.usage
            : undefined
        if (usage) {
            // A failed request leaves a `<synthetic>` message with all-zero
            // usage; it says nothing about the context, so keep the last reading.
            const tokens = contextTokens(usage)
            if (tokens > 0) entry.tokens = tokens
            return
        }
        // Codex reports usage separately, with its own window; so do ACP
        // agents such as agy, through the same message.
        const codex = content.content?.type === 'codex' && content.content.data?.type === 'token_count'
            ? codexContext(content.content.data.info)
            : null
        if (codex) {
            entry.tokens = codex.tokens
            if (codex.window) entry.window = codex.window
            return
        }
        if (content.content?.type === 'event' && content.content.data?.type === 'ready') {
            void this.onTurnEnd(session, entry)
        }
    }

    private async onTurnEnd(session: Session, entry: { tokens: number; phase: Phase; window?: number }): Promise<void> {
        try {
            if (entry.phase === 'compacting') {
                entry.phase = 'idle'
                entry.tokens = 0
                this.deps.onCompacted(session.id)
                return
            }
            // `/compact` waits for background work and can hang on it, so neither
            // step starts while anything is still running in the background.
            if ((session.backgroundTaskCount ?? 0) > 0) return

            if (entry.phase === 'curating') {
                entry.phase = 'compacting'
                await this.deps.send(session.id, ASSISTANT_COMPACT_COMMAND)
                return
            }
            const reported = entry.window ?? contextWindowFor(session.model)
            const window = session.metadata?.flavor === 'agy' ? Math.min(reported, AGY_WINDOW_CAP) : reported
            if (entry.tokens >= window * (this.deps.threshold ?? ASSISTANT_COMPACT_THRESHOLD)) {
                entry.phase = 'curating'
                await this.deps.send(session.id, CURATE_BEFORE_COMPACT_PROMPT(Math.round((entry.tokens / window) * 100)))
                // The curate turn, then the compact turn.
                this.quietReadies.set(session.id, 2)
            }
        } catch (error) {
            this.deps.logError?.(`[assistant] compaction step failed for ${session.id}: ${String(error)}`)
        }
    }
}

function contextTokens(usage: Record<string, unknown>): number {
    const n = (key: string) => (typeof usage[key] === 'number' ? usage[key] as number : 0)
    return n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens')
}

/**
 * `last` is the latest request, which is what is in context; Codex's input
 * count already includes cached input. ACP agents send what is in context
 * directly as `contextTokens`.
 */
function codexContext(info: Record<string, unknown> | undefined): { tokens: number; window?: number } | null {
    const window = info?.modelContextWindow ?? info?.model_context_window
    const windowValue = typeof window === 'number' && window > 0 ? window : undefined
    if (typeof info?.contextTokens === 'number' && info.contextTokens > 0) {
        return { tokens: info.contextTokens, window: windowValue }
    }
    const last = info?.last ?? info?.lastTokenUsage ?? info?.last_token_usage
    if (!last || typeof last !== 'object') return null
    const record = last as Record<string, unknown>
    const tokens = record.inputTokens ?? record.input_tokens
    if (typeof tokens !== 'number') return null
    return { tokens, window: windowValue }
}
