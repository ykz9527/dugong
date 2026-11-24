import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    DEFAULT_ASSISTANT_AGENT,
    type AssistantAgent,
    type AssistantGrant,
    type AssistantMemory,
    type AssistantQuestion,
    type CreateAssistantMemoryRequest,
    type UpdateAssistantMemoryRequest
} from '@hapi/protocol'
import { readableError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

/**
 * The task assistant's data for one workspace user: which session is theirs,
 * what it remembers, and what it may do without asking. Memory and grants are
 * refreshed by SSE nudges (`assistant-memory-updated` / `-grants-updated` /
 * `-questions-updated`).
 */

/** Queries below are disabled until both are known; this is what their
 *  `queryFn`s and the mutations stand on. */
function requireScope(api: ApiClient | null, workspaceUserId: string | null): { api: ApiClient; workspaceUserId: string } {
    if (!api || !workspaceUserId) throw new Error('API unavailable')
    return { api, workspaceUserId }
}

function requireApi(api: ApiClient | null): ApiClient {
    if (!api) throw new Error('API unavailable')
    return api
}

export function useAssistantSessionId(api: ApiClient | null, workspaceUserId: string | null): {
    sessionId: string | null
    agent: AssistantAgent
    /** The machine the person pinned the assistant to; null is automatic. */
    machineId: string | null
    /** Where the current conversation runs, when there is one. */
    sessionMachineId: string | null
    isLoading: boolean
    /** The lookup itself failed; the panel cannot tell "no assistant yet" from this. */
    error: string | null
    setSessionId: (sessionId: string) => void
    setAgent: (agent: AssistantAgent) => Promise<void>
    setMachine: (machineId: string | null) => Promise<void>
    /** Ask the hub again; it finds the assistant by metadata if the id went stale. */
    refresh: () => void
} {
    const queryClient = useQueryClient()
    const queryKey = queryKeys.assistantSession(workspaceUserId ?? '')
    const query = useQuery({
        queryKey,
        queryFn: async () => {
            const scope = requireScope(api, workspaceUserId)
            return await scope.api.getAssistantSession(scope.workspaceUserId)
        },
        enabled: Boolean(api && workspaceUserId)
    })
    const refresh = useCallback(() => {
        if (!workspaceUserId) return
        void queryClient.invalidateQueries({ queryKey: queryKeys.assistantSession(workspaceUserId) })
    }, [queryClient, workspaceUserId])
    const agent = query.data?.agent ?? DEFAULT_ASSISTANT_AGENT
    const machineId = query.data?.machineId ?? null
    return {
        sessionId: query.data?.sessionId ?? null,
        agent,
        machineId,
        sessionMachineId: query.data?.sessionMachineId ?? null,
        isLoading: query.isLoading,
        error: query.error ? readableError(query.error) : null,
        // The hub answers every send with the session it used; a reopen can
        // fold the conversation into a new row, and the panel follows it.
        setSessionId: (sessionId) => {
            if (!workspaceUserId) return
            const current = query.data
            if (current?.sessionId === sessionId) return
            // A new conversation runs where the pin says, or wherever the hub
            // chose; ask the hub which machine that was.
            queryClient.setQueryData(queryKey, { sessionId, agent, machineId, sessionMachineId: machineId })
            if (!machineId) refresh()
        },
        // Each agent keeps its own conversation; the hub answers with the
        // new agent's session, if it already has one.
        setAgent: async (next) => {
            if (!api || !workspaceUserId) return
            queryClient.setQueryData(queryKey, await api.setAssistantAgent({ workspaceUserId, agent: next }))
        },
        // Same for machines: the hub stops the conversation elsewhere and
        // answers with the one on the new machine, if any.
        setMachine: async (next) => {
            if (!api || !workspaceUserId) return
            queryClient.setQueryData(queryKey, await api.setAssistantMachine({ workspaceUserId, machineId: next }))
        },
        refresh
    }
}

export function useAssistantMemories(api: ApiClient | null, workspaceUserId: string | null): {
    memories: AssistantMemory[]
    isLoading: boolean
    error: string | null
} {
    const query = useQuery({
        queryKey: queryKeys.assistantMemories(workspaceUserId ?? ''),
        queryFn: async () => {
            const scope = requireScope(api, workspaceUserId)
            return (await scope.api.getAssistantMemories(scope.workspaceUserId)).memories
        },
        enabled: Boolean(api && workspaceUserId)
    })
    return {
        memories: query.data ?? [],
        isLoading: query.isLoading,
        error: query.error ? readableError(query.error) : null
    }
}

export function useAssistantGrants(api: ApiClient | null, workspaceUserId: string | null): AssistantGrant[] {
    const query = useQuery({
        queryKey: queryKeys.assistantGrants(workspaceUserId ?? ''),
        queryFn: async () => {
            const scope = requireScope(api, workspaceUserId)
            return (await scope.api.getAssistantGrants(scope.workspaceUserId)).grants
        },
        enabled: Boolean(api && workspaceUserId)
    })
    return query.data ?? []
}

export function useAssistantQuestions(api: ApiClient | null, workspaceUserId: string | null): {
    questions: AssistantQuestion[]
    isLoading: boolean
} {
    const query = useQuery({
        queryKey: queryKeys.assistantQuestions(workspaceUserId ?? ''),
        queryFn: async () => {
            const scope = requireScope(api, workspaceUserId)
            return (await scope.api.getAssistantQuestions(scope.workspaceUserId)).questions
        },
        enabled: Boolean(api && workspaceUserId)
    })
    return { questions: query.data ?? [], isLoading: query.isLoading }
}

/** Answer one of the assistant's questions for later. */
export function useAnswerAssistantQuestion(api: ApiClient | null, workspaceUserId: string | null) {
    const queryClient = useQueryClient()
    const mutation = useMutation({
        mutationFn: async (input: { id: string; answer: string }) =>
            await requireApi(api).answerAssistantQuestion(input.id, input.answer),
        onSettled: () => {
            if (workspaceUserId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.assistantQuestions(workspaceUserId) })
            }
        }
    })
    return {
        answer: mutation.mutateAsync,
        isPending: mutation.isPending,
        error: mutation.error ? readableError(mutation.error) : null
    }
}

/** Everything the person can do to their assistant's memory and grants. */
export function useAssistantActions(api: ApiClient | null, workspaceUserId: string | null) {
    const queryClient = useQueryClient()
    const refreshMemories = () => {
        if (workspaceUserId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.assistantMemories(workspaceUserId) })
        }
    }
    const refreshGrants = () => {
        if (workspaceUserId) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.assistantGrants(workspaceUserId) })
        }
    }

    const create = useMutation({
        mutationFn: async (payload: CreateAssistantMemoryRequest) => (await requireApi(api).createAssistantMemory(payload)).memory,
        onSuccess: refreshMemories
    })
    const update = useMutation({
        mutationFn: async (input: { id: string; patch: UpdateAssistantMemoryRequest }) =>
            (await requireApi(api).updateAssistantMemory(input.id, input.patch)).memory,
        onSuccess: refreshMemories
    })
    const remove = useMutation({
        mutationFn: async (id: string) => { await requireApi(api).deleteAssistantMemory(id) },
        onSuccess: refreshMemories
    })
    const undo = useMutation({
        mutationFn: async (id: string) => await requireApi(api).undoAssistantMemory(id),
        onSuccess: refreshMemories
    })
    const revokeGrant = useMutation({
        mutationFn: async (grantId: string) => {
            const scope = requireScope(api, workspaceUserId)
            await scope.api.revokeAssistantGrant(scope.workspaceUserId, grantId)
        },
        onSuccess: refreshGrants
    })

    const failed = [create, update, remove, undo, revokeGrant].find((mutation) => mutation.error)

    return {
        create: create.mutateAsync,
        update: update.mutateAsync,
        remove: remove.mutateAsync,
        undo: undo.mutateAsync,
        revokeGrant: revokeGrant.mutateAsync,
        isPending: create.isPending || update.isPending || remove.isPending || undo.isPending || revokeGrant.isPending,
        error: failed ? readableError(failed.error) : null
    }
}
