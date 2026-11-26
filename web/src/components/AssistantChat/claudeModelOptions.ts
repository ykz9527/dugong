import { CLAUDE_MODEL_PRESETS, getClaudeModelLabel } from '@hapi/protocol'
import type { ClaudeModelSummary } from '@hapi/protocol/apiTypes'
import type { Metadata } from '@hapi/protocol/schemas'

export type ClaudeComposerModelOption = {
    value: string | null
    label: string
    /** The id Claude Code resolves this choice to on the session's machine. */
    resolvedModel?: string
    /** Claude Code on that machine does not offer it (e.g. not in `availableModels`). */
    unavailable?: boolean
}

function normalizeClaudeComposerModel(model?: string | null): string | null {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }

    return trimmedModel
}

export function getClaudeComposerModelOptions(
    currentModel?: string | null,
    catalog?: readonly ClaudeModelSummary[]
): ClaudeComposerModelOption[] {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    const options: ClaudeComposerModelOption[] = [
        { value: null, label: 'Default' }
    ]

    if (
        normalizedCurrentModel
        && !CLAUDE_MODEL_PRESETS.includes(normalizedCurrentModel as typeof CLAUDE_MODEL_PRESETS[number])
    ) {
        options.push({
            value: normalizedCurrentModel,
            label: getClaudeModelLabel(normalizedCurrentModel) ?? normalizedCurrentModel
        })
    }

    options.push(...CLAUDE_MODEL_PRESETS.map((model) => ({
        value: model,
        label: getClaudeModelLabel(model) ?? model
    })))

    return catalog && catalog.length > 0 ? labelClaudeModelOptions(options, catalog) : options
}

const ONE_M_SUFFIX = '[1m]'
// Claude model ids as Claude Code reports them: claude-opus-5-5, claude-sonnet-4-5-20250929.
const CLAUDE_MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/

/** "Opus 5.5" from `claude-opus-5-5`; null for anything else. */
function nameFromModelId(id: string): string | null {
    const match = CLAUDE_MODEL_ID_PATTERN.exec(id)
    if (!match) return null
    const [, family, major, minor] = match
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`
}

/** Claude Code's name for an entry; older Claude Code names say only "Opus", so the version comes from its id. */
function entryName(entry: ClaudeModelSummary): string {
    if (/\d/.test(entry.displayName) || !entry.resolvedModel) return entry.displayName
    return nameFromModelId(entry.resolvedModel) ?? entry.displayName
}

function mentionsFamily(entry: ClaudeModelSummary, family: string): boolean {
    const pattern = new RegExp(`(^|-)${family}(-|\\[|$)`)
    return pattern.test(entry.value) || (entry.resolvedModel !== null && pattern.test(entry.resolvedModel))
}

/**
 * Names each choice the way Claude Code on the machine does ("Opus 5.5",
 * "Opus 5.5 1M", "Default · Opus 5.5"), from its own model list, so a new
 * Claude Code version relabels them without a dugong change. Claude Code
 * lists no `[1m]` entries; those take their base alias's name. An alias the
 * list does not name keeps its plain name: its version is not known.
 *
 * Unavailable = the list has nothing at all of that family (Fable on a
 * machine whose `availableModels` leaves it out): Claude Code would silently
 * run the default model instead. Absence of the alias alone is not enough:
 * Claude Code 2.1.323 lists Fable only as `claude-fable-5-1[1m]`, yet
 * `--model fable` works there.
 */
export function labelClaudeModelOptions(
    options: readonly ClaudeComposerModelOption[],
    catalog: readonly ClaudeModelSummary[]
): ClaudeComposerModelOption[] {
    const byValue = new Map(catalog.map((entry) => [entry.value, entry]))
    const listsAliases = CLAUDE_MODEL_PRESETS.some((preset) => byValue.has(preset))
    const nameOf = (resolved: string) => {
        const entry = catalog.find((candidate) => candidate.value !== 'default' && candidate.resolvedModel === resolved)
        return entry ? entryName(entry) : nameFromModelId(resolved) ?? resolved
    }

    return options.map((option) => {
        if (option.value === null) {
            const resolved = byValue.get('default')?.resolvedModel
            return resolved ? { ...option, label: `${option.label} · ${nameOf(resolved)}`, resolvedModel: resolved } : option
        }
        const oneM = option.value.endsWith(ONE_M_SUFFIX)
        const base = oneM ? option.value.slice(0, -ONE_M_SUFFIX.length) : option.value
        const entry = byValue.get(base)
        if (entry) {
            const name = entryName(entry)
            return {
                ...option,
                label: oneM ? `${name} 1M` : name,
                ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {})
            }
        }
        const isAlias = (CLAUDE_MODEL_PRESETS as readonly string[]).includes(option.value)
        const familyListed = catalog.some((candidate) => mentionsFamily(candidate, base))
        return isAlias && listsAliases && !familyListed ? { ...option, unavailable: true } : option
    })
}

export function getNextClaudeComposerModel(currentModel?: string | null): string | null {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    const options = getClaudeComposerModelOptions(normalizedCurrentModel)
    const currentIndex = options.findIndex((option) => option.value === normalizedCurrentModel)

    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }

    return options[(currentIndex + 1) % options.length]?.value ?? null
}

/**
 * The model Claude Code actually runs for the current selection, as it
 * reported it. Null when it has not reported one for this selection yet (a
 * new session, or a switch whose first turn has not started): never guessed.
 */
export function getClaudeResolvedModel(
    metadata: Pick<Metadata, 'claudeResolvedModel'> | null | undefined,
    currentModel?: string | null
): string | null {
    const resolved = metadata?.claudeResolvedModel
    if (!resolved) return null
    return resolved.selected === normalizeClaudeComposerModel(currentModel) ? resolved.model : null
}
