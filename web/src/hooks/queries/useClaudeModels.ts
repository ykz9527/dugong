import { useQuery } from '@tanstack/react-query'
import type { ClaudeModelSummary } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

// The runner keeps the list 5 minutes and then serves it while it refreshes;
// keep ours 30 minutes so reopening a Claude session labels its models at once.
const CLAUDE_MODELS_STALE_MS = 5 * 60_000
const CLAUDE_MODELS_GC_MS = 30 * 60_000

/**
 * Claude Code's own model list on a machine (alias -> version, e.g. opus ->
 * "Opus 5.5"). Empty until it arrives or when the machine cannot answer: the
 * picker then keeps its plain alias names.
 */
export function useClaudeModels(args: {
    api: ApiClient | null
    machineId?: string | null
    enabled?: boolean
}): ClaudeModelSummary[] {
    const { api, machineId } = args
    const query = useQuery({
        queryKey: queryKeys.machineClaudeModels(machineId ?? 'unknown'),
        queryFn: async () => {
            if (!api || !machineId) throw new Error('Claude models target unavailable')
            return await api.getMachineClaudeModels(machineId)
        },
        enabled: Boolean(args.enabled && api && machineId),
        staleTime: CLAUDE_MODELS_STALE_MS,
        gcTime: CLAUDE_MODELS_GC_MS,
        retry: false,
    })
    return query.data?.success ? query.data.models ?? [] : []
}
