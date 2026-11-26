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

/**
 * Names each choice the way Claude Code on the machine does ("Opus 5.5",
 * "Opus 5.5 1M", "Default · Opus 5.5"), from its own model list, so a new
 * Claude Code version relabels them without a dugong change. Claude Code
 * lists no `[1m]` entries; those take their base alias's name. An alias
 * missing from a list that names any alias is unavailable there: Claude Code
 * would silently run the default model instead.
 */
export function labelClaudeModelOptions(
    options: readonly ClaudeComposerModelOption[],
    catalog: readonly ClaudeModelSummary[]
): ClaudeComposerModelOption[] {
    const byValue = new Map(catalog.map((entry) => [entry.value, entry]))
    const listsAliases = CLAUDE_MODEL_PRESETS.some((preset) => byValue.has(preset))
    const nameOf = (resolved: string) =>
        catalog.find((entry) => entry.value !== 'default' && entry.resolvedModel === resolved)?.displayName ?? resolved

    return options.map((option) => {
        if (option.value === null) {
            const resolved = byValue.get('default')?.resolvedModel
            return resolved ? { ...option, label: `${option.label} · ${nameOf(resolved)}`, resolvedModel: resolved } : option
        }
        const oneM = option.value.endsWith(ONE_M_SUFFIX)
        const entry = byValue.get(oneM ? option.value.slice(0, -ONE_M_SUFFIX.length) : option.value)
        if (entry) {
            return {
                ...option,
                label: oneM ? `${entry.displayName} 1M` : entry.displayName,
                ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {})
            }
        }
        const isAlias = (CLAUDE_MODEL_PRESETS as readonly string[]).includes(option.value)
        return isAlias && listsAliases ? { ...option, unavailable: true } : option
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
