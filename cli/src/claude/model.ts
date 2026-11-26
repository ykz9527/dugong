import type { Metadata } from '@hapi/protocol/schemas'
import type { SessionModel } from '@/api/types'

export function normalizeClaudeSessionModel(model?: string | null): SessionModel {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }

    return trimmedModel
}

type ResolvedModelClient = {
    getMetadata(): Readonly<Metadata> | null
    updateMetadata(handler: (metadata: Metadata) => Metadata): void
}

/**
 * Record what Claude Code resolved this turn's model selection to (its
 * system/init `model`), paired with the selection itself so the web never
 * shows one alias's resolution next to another. Skips the write when nothing
 * changed: init repeats on every turn.
 */
export function reportClaudeResolvedModel(
    client: ResolvedModelClient,
    selectedModel: string | null | undefined,
    resolvedModel: unknown
): void {
    if (typeof resolvedModel !== 'string' || !resolvedModel.trim()) return
    const next = { selected: normalizeClaudeSessionModel(selectedModel), model: resolvedModel.trim() }
    const current = client.getMetadata()?.claudeResolvedModel
    if (current && current.selected === next.selected && current.model === next.model) return
    client.updateMetadata((metadata) => ({ ...metadata, claudeResolvedModel: next }))
}
