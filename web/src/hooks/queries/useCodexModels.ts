import { useQuery } from '@tanstack/react-query'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexModelSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

// The runner caches the catalog for 5 minutes too; refetching sooner only
// re-asks the hub (a full relay round trip) for the same list. Keep it around
// for 30 minutes so switching back to a Codex session shows its model at once
// while a stale list refreshes in the background.
const CODEX_MODELS_STALE_MS = 5 * 60_000
const CODEX_MODELS_GC_MS = 30 * 60_000

export function useCodexModels(args: {
    api: ApiClient | null
    sessionId?: string | null
    machineId?: string | null
    enabled?: boolean
}): {
    models: CodexModelSummary[]
    isLoading: boolean
    error: string | null
} {
    const { api, sessionId, machineId } = args
    const enabled = Boolean(args.enabled && api && (sessionId || machineId))

    const machineQuery = useQuery({
        queryKey: queryKeys.machineCodexModels(machineId ?? 'unknown'),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (machineId) {
                return await api.getMachineCodexModels(machineId)
            }
            throw new Error('Codex models target unavailable')
        },
        enabled: Boolean(enabled && machineId),
        staleTime: CODEX_MODELS_STALE_MS,
        gcTime: CODEX_MODELS_GC_MS,
        retry: false,
    })

    // Successful machine discovery stays shared across chats and New Session.
    // Only an absent machine RPC unlocks the per-session neutral fallback.
    const useSessionFallback = Boolean(
        enabled
        && sessionId
        && (!machineId || (
            machineQuery.error instanceof ApiError
            && machineQuery.error.code === RPC_TARGET_MISSING_ERROR_CODE
        ))
    )
    const sessionQuery = useQuery({
        queryKey: queryKeys.sessionCodexModels(sessionId ?? 'unknown'),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (sessionId) {
                return await api.getSessionCodexModels(sessionId)
            }
            throw new Error('Codex models fallback target unavailable')
        },
        enabled: useSessionFallback,
        staleTime: CODEX_MODELS_STALE_MS,
        gcTime: CODEX_MODELS_GC_MS,
        retry: false,
    })
    const query = useSessionFallback ? sessionQuery : machineQuery

    return {
        models: query.data?.models ?? [],
        isLoading: query.isLoading,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to load Codex models')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to load Codex models'
                    : null,
    }
}
