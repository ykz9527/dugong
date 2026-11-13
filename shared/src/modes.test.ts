import { describe, expect, it, test } from 'bun:test'
import {
    AGENT_FLAVORS,
    AgentFlavorSchema,
    CREATABLE_AGENT_FLAVORS,
    getPermissionModeLabel,
    getPermissionModeOptionsForFlavor,
    getPermissionModeTone,
    getPermissionModesForFlavor,
    isPermissionModeAllowedForFlavor,
    isSteeringSupportedForFlavor,
    isSteeringSupportedForSession,
    DEFAULT_CLAUDE_PERMISSION_MODE,
    getDefaultPermissionModeForFlavor,
    isPermissionModeSwitchQueued,
    permissionModeTakesEffectNextTurn,
} from './modes'

describe('Gemini CLI sunset (read-only, not creatable)', () => {
    test('gemini stays a valid flavor so existing stored sessions still validate/load', () => {
        expect(AGENT_FLAVORS).toContain('gemini')
        expect(AgentFlavorSchema.safeParse('gemini').success).toBe(true)
    })

    test('gemini is excluded from creatable flavors (not offered for new sessions)', () => {
        expect(CREATABLE_AGENT_FLAVORS).not.toContain('gemini')
    })

    test('all other flavors remain creatable', () => {
        for (const flavor of AGENT_FLAVORS) {
            if (flavor === 'gemini') continue
            expect(CREATABLE_AGENT_FLAVORS).toContain(flavor)
        }
    })
})

describe('getPermissionModesForFlavor', () => {
    test("returns the conservative Grok modes", () => {
        expect(getPermissionModesForFlavor('grok')).toEqual([
            'default',
            'auto',
            'plan',
            'bypassPermissions'
        ])
    })

    test("returns no HAPI mode selector for DSH's server-owned permission policy", () => {
        expect(getPermissionModesForFlavor('dsh')).toEqual([])
    })

    test("returns [] for flavor 'pi' (RPC mode has no runtime permission switching)", () => {
        expect(getPermissionModesForFlavor('pi')).toEqual([])
    })

    test("returns [] for pi and does not fall back to Claude modes", () => {
        // Ensure Pi is opt-in empty, not silently inheriting Claude defaults.
        expect(getPermissionModesForFlavor('pi')).not.toEqual(getPermissionModesForFlavor('claude'))
        expect(getPermissionModesForFlavor('pi')).not.toEqual(getPermissionModesForFlavor(null))
    })

    test("unknown flavors fall back to Claude modes, not Pi's empty list", () => {
        expect(getPermissionModesForFlavor(null)).not.toEqual([])
        expect(getPermissionModesForFlavor(undefined)).not.toEqual([])
        expect(getPermissionModesForFlavor('PI')).not.toEqual([])
        expect(getPermissionModesForFlavor('Pi')).not.toEqual([])
    })
})

describe('getPermissionModeOptionsForFlavor', () => {
    test("returns [] for pi (no permission options offered)", () => {
        expect(getPermissionModeOptionsForFlavor('pi')).toEqual([])
    })
})

describe('isPermissionModeAllowedForFlavor', () => {
    test("allows only the supported Grok modes", () => {
        expect(isPermissionModeAllowedForFlavor('default', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('plan', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'grok')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'grok')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('yolo', 'grok')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('read-only', 'dsh')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('plan', 'dsh')).toBe(false)
    })

    test("no mode is allowed for pi", () => {
        expect(isPermissionModeAllowedForFlavor('yolo', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('default', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('plan', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('acceptEdits', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('bypassPermissions', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('read-only', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('safe-yolo', 'pi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('ask', 'pi')).toBe(false)
    })

    test("cursor includes autoReview", () => {
        expect(getPermissionModesForFlavor('cursor')).toContain('autoReview')
        expect(getPermissionModeLabel('autoReview')).toBe('Auto-review')
        expect(getPermissionModeTone('autoReview')).toBe('warning')
        expect(isPermissionModeAllowedForFlavor('autoReview', 'cursor')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('autoReview', 'claude')).toBe(false)
    })
})

describe('getPermissionModeLabel', () => {
    test("yolo label is 'Yolo'", () => {
        expect(getPermissionModeLabel('yolo')).toBe('Yolo')
    })

    test("default label is 'Default'", () => {
        expect(getPermissionModeLabel('default')).toBe('Default')
    })
})

describe('getPermissionModeTone', () => {
    test("yolo tone is danger", () => {
        expect(getPermissionModeTone('yolo')).toBe('danger')
    })

    test("default tone is neutral", () => {
        expect(getPermissionModeTone('default')).toBe('neutral')
    })
})

describe('claude auto permission mode', () => {
    it('is allowed for claude and codex only', () => {
        expect(isPermissionModeAllowedForFlavor('auto', 'claude')).toBe(true)
        // Codex's `auto` is its own Auto Review, not Claude's classifier.
        expect(isPermissionModeAllowedForFlavor('auto', 'codex')).toBe(true)
        expect(isPermissionModeAllowedForFlavor('auto', 'gemini')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'cursor')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'opencode')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'kimi')).toBe(false)
        expect(isPermissionModeAllowedForFlavor('auto', 'pi')).toBe(false)
    })

    it('has a label and tone', () => {
        expect(getPermissionModeLabel('auto')).toBe('Auto')
        expect(getPermissionModeTone('auto')).toBe('warning')
    })
})

describe('isSteeringSupportedForFlavor', () => {
    it('supports codex, cursor and pi', () => {
        expect(isSteeringSupportedForFlavor('codex')).toBe(true)
        expect(isSteeringSupportedForFlavor('cursor')).toBe(true)
        expect(isSteeringSupportedForFlavor('pi')).toBe(true)
        expect(isSteeringSupportedForFlavor('claude')).toBe(false)
        expect(isSteeringSupportedForFlavor('opencode')).toBe(false)
        expect(isSteeringSupportedForFlavor(undefined)).toBe(false)
        expect(isSteeringSupportedForFlavor(null)).toBe(false)
    })
})

describe('isSteeringSupportedForSession', () => {
    it('supports codex and pi sessions', () => {
        expect(isSteeringSupportedForSession({ flavor: 'codex' })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'pi' })).toBe(true)
    })

    it('supports Cursor ACP sessions', () => {
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionProtocol: 'acp',
            cursorSessionId: 'sess-1',
        })).toBe(true)
        expect(isSteeringSupportedForSession({ flavor: 'cursor' })).toBe(true)
    })

    it('rejects legacy Cursor stream-json sessions', () => {
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionProtocol: 'stream-json',
            cursorSessionId: 'legacy-1',
        })).toBe(false)
        expect(isSteeringSupportedForSession({
            flavor: 'cursor',
            cursorSessionId: 'legacy-without-protocol',
        })).toBe(false)
    })

    it('rejects non-steerable flavors', () => {
        expect(isSteeringSupportedForSession({ flavor: 'claude' })).toBe(false)
        expect(isSteeringSupportedForSession(null)).toBe(false)
    })
})

describe('getDefaultPermissionModeForFlavor', () => {
    it('starts an unspecified Claude session on auto', () => {
        // `default` stops at every uncleared tool, which turns an unattended
        // session into a queue of prompts nobody is there to answer.
        expect(getDefaultPermissionModeForFlavor('claude')).toBe('auto')
        expect(getDefaultPermissionModeForFlavor('claude')).toBe(DEFAULT_CLAUDE_PERMISSION_MODE)
    })

    it('starts an unspecified Codex session on auto', () => {
        expect(getDefaultPermissionModeForFlavor('codex')).toBe('auto')
    })

    it('leaves every other flavor on its own default', () => {
        // Grok has an `auto` too, but nobody asked for its default to move.
        expect(getDefaultPermissionModeForFlavor('grok')).toBe('default')
        expect(getDefaultPermissionModeForFlavor('cursor')).toBe('default')
        expect(getDefaultPermissionModeForFlavor('gemini')).toBe('default')
    })

    it('treats an unknown flavor as Claude, like the mode list does', () => {
        expect(getDefaultPermissionModeForFlavor(null)).toBe('auto')
        expect(getDefaultPermissionModeForFlavor(undefined)).toBe('auto')
    })

    it('never returns a mode the flavor rejects', () => {
        // `pi` and `dsh` are left out on purpose: they offer no permission
        // modes at all, so there is no correct answer and no caller either —
        // the composer hides the control when the mode list is empty.
        for (const flavor of ['claude', 'codex', 'cursor', 'grok', 'opencode', 'kimi', 'copilot', 'gemini', 'agy']) {
            const mode = getDefaultPermissionModeForFlavor(flavor)
            expect(isPermissionModeAllowedForFlavor(mode, flavor)).toBe(true)
        }
    })
})

describe('isPermissionModeSwitchQueued', () => {
    it('is quiet for modes the CLI enforces without restarting', () => {
        // acceptEdits / bypassPermissions bind on the very next tool call, so
        // there is never a gap to explain.
        expect(isPermissionModeSwitchQueued({ selected: 'acceptEdits', active: 'default' })).toBe(false)
        expect(isPermissionModeSwitchQueued({ selected: 'bypassPermissions', active: 'default' })).toBe(false)
    })

    it('reports a switch the running process has not picked up', () => {
        expect(isPermissionModeSwitchQueued({ selected: 'auto', active: 'default' })).toBe(true)
        expect(isPermissionModeSwitchQueued({ selected: 'plan', active: 'acceptEdits' })).toBe(true)
    })

    it('is quiet once the process runs under the chosen mode', () => {
        expect(isPermissionModeSwitchQueued({ selected: 'auto', active: 'auto' })).toBe(false)
    })

    it('falls back to a pending request when nothing reports what is running', () => {
        // Older runners do not report it; going silent there would lose the
        // only warning the operator used to get.
        expect(isPermissionModeSwitchQueued({ selected: 'auto', pendingRequestCount: 1 })).toBe(true)
        expect(isPermissionModeSwitchQueued({ selected: 'auto', pendingRequestCount: 0 })).toBe(false)
        expect(isPermissionModeSwitchQueued({ selected: 'auto' })).toBe(false)
    })

    it('treats a stopped process as nothing to warn about', () => {
        // null is a positive report that no process is up, so no turn is
        // holding a switch back — unlike undefined, which means "not reported"
        // and still falls back to the pending-request signal.
        expect(isPermissionModeSwitchQueued({ selected: 'auto', active: null })).toBe(false)
        expect(isPermissionModeSwitchQueued({ selected: 'auto', active: null, pendingRequestCount: 1 })).toBe(false)
    })
})

describe('permissionModeTakesEffectNextTurn', () => {
    it('flags the modes claude enforces itself', () => {
        // `--permission-mode` flags on the claude process: they only bind when a
        // new process starts, which is why a mid-turn switch appears to do nothing.
        expect(permissionModeTakesEffectNextTurn('auto')).toBe(true)
        expect(permissionModeTakesEffectNextTurn('plan')).toBe(true)
    })

    it('leaves the ones HAPI emulates alone', () => {
        // Handled inside the CLI's own permission handler — effective at once.
        expect(permissionModeTakesEffectNextTurn('acceptEdits')).toBe(false)
        expect(permissionModeTakesEffectNextTurn('bypassPermissions')).toBe(false)
        expect(permissionModeTakesEffectNextTurn('default')).toBe(false)
        expect(permissionModeTakesEffectNextTurn('read-only')).toBe(false)
    })

    it('holds every Codex mode until the next turn', () => {
        // Sandbox and approval policy travel with turn/start, so a switch
        // from yolo to read-only mid-turn still leaves this turn writable.
        expect(permissionModeTakesEffectNextTurn('read-only', 'codex')).toBe(true)
        expect(permissionModeTakesEffectNextTurn('yolo', 'codex')).toBe(true)
        expect(isPermissionModeSwitchQueued({ selected: 'read-only', active: 'yolo', flavor: 'codex' })).toBe(true)
        expect(isPermissionModeSwitchQueued({ selected: 'read-only', active: null, flavor: 'codex' })).toBe(false)
    })
})
