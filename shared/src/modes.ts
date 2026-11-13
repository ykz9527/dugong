import { z } from 'zod'

/**
 * @description The legacy payload type identifier used for all generic agent messages.
 * Changing this value will affect the communication schema between CLI, Hub, and Web.
 * A migration plan is required if this literal is ever modified.
 */
export const AGENT_MESSAGE_PAYLOAD_TYPE = 'codex' as const

export const AGENT_FLAVORS = ['agy', 'claude', 'codex', 'dsh', 'copilot', 'cursor', 'gemini', 'grok', 'kimi', 'opencode', 'pi'] as const
export type AgentFlavor = typeof AGENT_FLAVORS[number]
export const AgentFlavorSchema = z.enum(AGENT_FLAVORS)

// Flavors offered when CREATING a new session. Gemini CLI is intentionally
// excluded: Google sunset the consumer Gemini CLI (2026-06-18) so it can no
// longer be launched. It is kept in AGENT_FLAVORS / AgentFlavorSchema above so
// existing stored Gemini sessions still validate and remain viewable.
export const CREATABLE_AGENT_FLAVORS: readonly AgentFlavor[] = AGENT_FLAVORS.filter(
    (flavor) => flavor !== 'gemini'
)

export const AGY_PERMISSION_MODES = ['request-review', 'always-proceed'] as const
export type AgyPermissionMode = typeof AGY_PERMISSION_MODES[number]

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'] as const
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number]

/**
 * What a Claude session runs as when nobody said.
 *
 * `default` stops at every tool it has not been cleared for, which for a
 * session driven from a phone or picked up from the board means the operator
 * spends the run answering prompts rather than reading results. `auto` leaves
 * the judgement to Claude itself — it still asks about the things it considers
 * risky — and is what makes an unattended session usable at all.
 *
 * Only a fallback. Anything that states a mode (a `--permission-mode` flag, a
 * mode remembered on the session, a pick in the composer) wins, including an
 * explicit `default`: that is a choice, not an absence.
 */
export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = 'auto'

export const CODEX_PERMISSION_MODES = ['default', 'auto', 'read-only', 'safe-yolo', 'yolo'] as const
export type CodexPermissionMode = typeof CODEX_PERMISSION_MODES[number]

/**
 * What a Codex session runs as when nobody said: Codex's own Auto Review.
 *
 * Same reasoning as `DEFAULT_CLAUDE_PERMISSION_MODE` — `default` stops at
 * every escalation. Under `auto` a reviewer subagent weighs each one and
 * approves or denies it by risk; the sandbox stays workspace-write. Only a
 * fallback: an explicit mode, including `default`, wins.
 */
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'auto'

export const CODEX_COLLABORATION_MODES = ['default', 'plan'] as const
export type CodexCollaborationMode = typeof CODEX_COLLABORATION_MODES[number]

export const GEMINI_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type GeminiPermissionMode = typeof GEMINI_PERMISSION_MODES[number]

export const KIMI_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type KimiPermissionMode = typeof KIMI_PERMISSION_MODES[number]

export const COPILOT_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type CopilotPermissionMode = typeof COPILOT_PERMISSION_MODES[number]

export const GROK_PERMISSION_MODES = ['default', 'auto', 'plan', 'bypassPermissions'] as const
export type GrokPermissionMode = typeof GROK_PERMISSION_MODES[number]

export const OPENCODE_PERMISSION_MODES = ['default', 'plan', 'yolo'] as const
export type OpencodePermissionMode = typeof OPENCODE_PERMISSION_MODES[number]

export const CURSOR_PERMISSION_MODES = ['default', 'plan', 'ask', 'debug', 'autoReview', 'yolo'] as const
export type CursorPermissionMode = typeof CURSOR_PERMISSION_MODES[number]

export const PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'plan',
    'ask',
    'debug',
    'autoReview',
    'read-only',
    'safe-yolo',
    'yolo',
    'request-review',
    'always-proceed'
] as const
export type PermissionMode = typeof PERMISSION_MODES[number]


export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    auto: 'Auto',
    plan: 'Plan Mode',
    ask: 'Ask Mode',
    debug: 'Debug Mode',
    autoReview: 'Auto-review',
    bypassPermissions: 'Yolo',
    'read-only': 'Read Only',
    'safe-yolo': 'Safe Yolo',
    yolo: 'Yolo',
    'request-review': 'Request Review',
    'always-proceed': 'Always Proceed'
}

export type PermissionModeTone = 'neutral' | 'info' | 'warning' | 'danger'

export const PERMISSION_MODE_TONES: Record<PermissionMode, PermissionModeTone> = {
    default: 'neutral',
    acceptEdits: 'warning',
    auto: 'warning',
    plan: 'info',
    ask: 'info',
    debug: 'info',
    autoReview: 'warning',
    bypassPermissions: 'danger',
    'read-only': 'warning',
    'safe-yolo': 'warning',
    yolo: 'danger',
    'request-review': 'neutral',
    'always-proceed': 'danger'
}

export type PermissionModeOption = {
    mode: PermissionMode
    label: string
    tone: PermissionModeTone
}

export type CodexCollaborationModeOption = {
    mode: CodexCollaborationMode
    label: string
}

export const CODEX_COLLABORATION_MODE_LABELS: Record<CodexCollaborationMode, string> = {
    default: 'Default',
    plan: 'Plan'
}

export function getPermissionModeLabel(mode: PermissionMode): string {
    return PERMISSION_MODE_LABELS[mode]
}

export function getPermissionModeTone(mode: PermissionMode): PermissionModeTone {
    return PERMISSION_MODE_TONES[mode]
}

export function getCodexCollaborationModeLabel(mode: CodexCollaborationMode): string {
    return CODEX_COLLABORATION_MODE_LABELS[mode]
}

/**
 * Modes Claude enforces itself, rather than HAPI emulating them.
 *
 * `acceptEdits` / `bypassPermissions` are implemented in the CLI's own
 * permission handler, so switching to them takes effect on the very next tool
 * call. `auto` and `plan` are `--permission-mode` flags on the claude process,
 * so switching to or from them only takes hold when a new process starts —
 * which happens at the next turn boundary, not mid-turn.
 *
 * Codex takes its sandbox and approval policy with each `turn/start`, so in a
 * Codex session every mode waits for the next turn.
 *
 * The practical consequence, and the reason this is exported: while the agent
 * is holding a permission request open, the turn has not ended, so a switch to
 * one of these sits queued behind it. The UI has to say so.
 */
export function permissionModeTakesEffectNextTurn(mode: PermissionMode, flavor?: string | null): boolean {
    if (flavor === 'codex') return true
    return mode === 'auto' || mode === 'plan'
}

/**
 * Has the operator picked a mode that is not in force yet?
 *
 * For Claude only `auto` and `plan` can be in this state, for Codex any mode,
 * and only while a turn started under something else is still running. Answering it
 * is what lets a permission request explain itself instead of leaving the
 * operator staring at a session labelled `Auto` that keeps asking.
 *
 * `active` is what the agent process reports it was started with. `null` is a
 * positive report that no process is up, so nothing is holding a switch back.
 * `undefined` is the absence of a report — an older runner, or an agent that
 * never sends one — and falls back to the narrower signal that something is
 * being asked right now, which is at least never wrong in the direction of
 * claiming a switch has landed.
 */
export function isPermissionModeSwitchQueued(input: {
    selected: PermissionMode
    active?: PermissionMode | null
    pendingRequestCount?: number
    flavor?: string | null
}): boolean {
    if (!permissionModeTakesEffectNextTurn(input.selected, input.flavor)) return false
    if (input.active === null) return false
    if (input.active === undefined) {
        return (input.pendingRequestCount ?? 0) > 0
    }
    return input.active !== input.selected
}

export function getPermissionModesForFlavor(flavor?: string | null): readonly PermissionMode[] {
    if (flavor === 'codex') {
        return CODEX_PERMISSION_MODES
    }
    if (flavor === 'gemini') {
        return GEMINI_PERMISSION_MODES
    }
    if (flavor === 'kimi') {
        return KIMI_PERMISSION_MODES
    }
    if (flavor === 'dsh') {
        return []
    }
    if (flavor === 'copilot') {
        return COPILOT_PERMISSION_MODES
    }
    if (flavor === 'grok') {
        return GROK_PERMISSION_MODES
    }
    if (flavor === 'opencode') {
        return OPENCODE_PERMISSION_MODES
    }
    if (flavor === 'agy') {
        return AGY_PERMISSION_MODES
    }
    if (flavor === 'cursor') {
        return CURSOR_PERMISSION_MODES
    }
    if (flavor === 'pi') {
        // Pi RPC mode has no runtime permission switching (always auto-approve);
        // no permission modes are offered.
        return []
    }
    return CLAUDE_PERMISSION_MODES
}

export function getPermissionModeOptionsForFlavor(flavor?: string | null): PermissionModeOption[] {
    return getPermissionModesForFlavor(flavor).map((mode) => ({
        mode,
        label: getPermissionModeLabel(mode),
        tone: getPermissionModeTone(mode)
    }))
}

/**
 * What a session of this flavor runs as when nobody said.
 *
 * Claude and Codex depart from `default` — see `DEFAULT_CLAUDE_PERMISSION_MODE`
 * and `DEFAULT_CODEX_PERMISSION_MODE`.
 * Grok also has an `auto`, but its default has not been reconsidered and
 * widening it here would be a change nobody asked for. An unknown flavor is
 * treated as Claude, matching `getPermissionModesForFlavor`.
 *
 * Flavors with no permission modes at all (`pi`, `dsh`) get a meaningless
 * `default` back. There is no right answer for them and no caller either — the
 * UI hides the control when the mode list is empty.
 */
export function getDefaultPermissionModeForFlavor(flavor?: string | null): PermissionMode {
    if (flavor === null || flavor === undefined || flavor === 'claude') {
        return DEFAULT_CLAUDE_PERMISSION_MODE
    }
    if (flavor === 'codex') {
        return DEFAULT_CODEX_PERMISSION_MODE
    }
    const modes = getPermissionModesForFlavor(flavor)
    return modes.includes('default') ? 'default' : (modes[0] ?? 'default')
}

export function isPermissionModeAllowedForFlavor(mode: PermissionMode, flavor?: string | null): boolean {
    return getPermissionModesForFlavor(flavor).includes(mode)
}

export function getCodexCollaborationModeOptions(): CodexCollaborationModeOption[] {
    return CODEX_COLLABORATION_MODES.map((mode) => ({
        mode,
        label: getCodexCollaborationModeLabel(mode)
    }))
}

/**
 * Flavors that can deliver a queued message into an active turn on demand
 * (per-message "Steer" from the waiting queue), without waiting for full-turn end.
 *
 * Steer = soft mid-turn delivery (same idea as Cursor GUI default "Send"):
 * - Pi: native steer over the Pi runtime (first-class since #1466)
 * - Codex: app-server `turn/steer` (true mid-turn inject)
 * - Cursor ACP: concurrent `session/prompt` soft-send (no cancel). Legacy
 *   stream-json Cursor sessions are NOT steerable — gate with
 *   {@link isSteeringSupportedForSession}.
 *
 * Claude / others: not supported (no reachable soft-steer path) — UI hides Steer.
 */
export const STEERING_SUPPORTED_FLAVORS = ['codex', 'cursor', 'pi'] as const

export function isSteeringSupportedForFlavor(flavor?: string | null): boolean {
    return (STEERING_SUPPORTED_FLAVORS as readonly string[]).includes(flavor ?? '')
}

/**
 * Session-aware steer gate. Prefer this over {@link isSteeringSupportedForFlavor}
 * when metadata is available: legacy Cursor stream-json sessions advertise
 * flavor `cursor` but cannot steer.
 *
 * Matches CLI legacy detection: explicit `stream-json`, or a pre-ACP session
 * that has `cursorSessionId` without `cursorSessionProtocol: 'acp'`.
 */
export function isSteeringSupportedForSession(metadata?: {
    flavor?: string | null
    cursorSessionId?: string | null
    cursorSessionProtocol?: 'acp' | 'stream-json' | null
} | null): boolean {
    if (metadata?.flavor === 'codex' || metadata?.flavor === 'pi') {
        return true
    }
    if (metadata?.flavor !== 'cursor') {
        return false
    }
    if (metadata.cursorSessionProtocol === 'stream-json') {
        return false
    }
    if (!metadata.cursorSessionProtocol && metadata.cursorSessionId) {
        return false
    }
    return true
}
