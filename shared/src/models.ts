export const CLAUDE_MODEL_LABELS = {
    sonnet: 'Sonnet',
    'sonnet[1m]': 'Sonnet 1M',
    opus: 'Opus',
    'opus[1m]': 'Opus 1M',
    fable: 'Fable',
    'fable[1m]': 'Fable 1M',
    haiku: 'Haiku'
} as const

export type ClaudeModelPreset = keyof typeof CLAUDE_MODEL_LABELS
export const CLAUDE_MODEL_PRESETS = Object.keys(CLAUDE_MODEL_LABELS) as ClaudeModelPreset[]

export const GEMINI_MODEL_LABELS = {
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
    'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
} as const

export type GeminiModelPreset = keyof typeof GEMINI_MODEL_LABELS
export const GEMINI_MODEL_PRESETS = Object.keys(GEMINI_MODEL_LABELS) as GeminiModelPreset[]
export const DEFAULT_GEMINI_MODEL: GeminiModelPreset = 'gemini-2.5-pro'

// Order and labels mirror `agy models` output (the agy CLI's own listing) so the
// HAPI picker matches what users see in the terminal. IDs follow agy's
// `<model>-<effort>` convention (e.g. `gemini-3.5-flash-low` verified accepted by
// `agy --model`). NOTE: agy fetches the live list server-side and `agy models`
// needs an interactive keyring unlock, so this stays a hand-maintained mirror —
// update it when agy's listing changes.
export const AGY_MODEL_LABELS = {
    'gemini-3.6-flash-high': 'Gemini 3.6 Flash (High)',
    'gemini-3.6-flash-medium': 'Gemini 3.6 Flash (Medium)',
    'gemini-3.6-flash-low': 'Gemini 3.6 Flash (Low)',
    'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
    'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
    'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
    'gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)',
    'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
    'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)',
} as const

export type AgyModelPreset = keyof typeof AGY_MODEL_LABELS
export const AGY_MODEL_PRESETS = Object.keys(AGY_MODEL_LABELS) as AgyModelPreset[]

export function getAgyModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) return null
    return AGY_MODEL_LABELS[trimmedModel as AgyModelPreset] ?? null
}

export function isClaudeModelPreset(model: string | null | undefined): model is ClaudeModelPreset {
    return typeof model === 'string' && Object.hasOwn(CLAUDE_MODEL_LABELS, model)
}

export function getClaudeModelLabel(model: string): string | null {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
        return null
    }

    return CLAUDE_MODEL_LABELS[trimmedModel as ClaudeModelPreset] ?? null
}

/**
 * Context window of a Claude model, for when no authoritative value is known.
 *
 * The authoritative source is the SDK result message
 * (`modelUsage[<model>].contextWindow`); this is only the fallback before the
 * first result of a process arrives, and for local transcripts that never
 * carry one. Checked 2026-11-22 against SDK results (claude-opus-5-5,
 * claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1 all report 1,000,000)
 * and the model table: every 5th-generation model, Fable and Mythos is 1M.
 * Older ids stay at 200k unless they carry the `[1m]` suffix: Claude Code
 * makes 1M opt-in for them (the opus[1m]/sonnet[1m] presets), and no SDK
 * result here confirms otherwise — an authoritative value replaces this anyway.
 *
 * Returns null for ids that are not Claude models.
 */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
export const CLAUDE_LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000

// Bare aliases resolve to the current generation, which is 1M across the board.
const CLAUDE_CURRENT_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable'])

export function getClaudeContextWindowTokens(model: string | null | undefined): number | null {
    const id = model?.trim().toLowerCase()
    if (!id) return null
    if (id.endsWith('[1m]')) return CLAUDE_LARGE_CONTEXT_WINDOW_TOKENS
    if (CLAUDE_CURRENT_ALIASES.has(id)) return CLAUDE_LARGE_CONTEXT_WINDOW_TOKENS
    if (!id.startsWith('claude-')) return null
    if (id.startsWith('claude-fable') || id.startsWith('claude-mythos')) return CLAUDE_LARGE_CONTEXT_WINDOW_TOKENS
    const generation = id.match(/^claude-(?:opus|sonnet|haiku)-(\d+)/)?.[1]
    if (generation && Number.parseInt(generation, 10) >= 5) return CLAUDE_LARGE_CONTEXT_WINDOW_TOKENS
    return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS
}
