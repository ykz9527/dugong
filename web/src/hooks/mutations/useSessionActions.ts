import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { CodexCollaborationMode, CopilotAgentMode, PermissionMode, SessionResponse, SessionsResponse } from '@/types/api'
import type { ReopenSessionResponse } from '@hapi/protocol/apiTypes'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow } from '@/lib/message-window-store'
import { isKnownFlavor } from '@hapi/protocol'

export const sessionModelMutationKey = (sessionId: string) => ['session-model', sessionId] as const

export function useSessionActions(
    api: ApiClient | null,
    sessionId: string | null,
    agentFlavor?: string | null,
    codexCollaborationModeSupported?: boolean
): {
    abortSession: () => Promise<void>
    archiveSession: () => Promise<void>
    reopenSession: () => Promise<ReopenSessionResponse>
    switchSession: () => Promise<void>
    setPermissionMode: (mode: PermissionMode) => Promise<void>
    setCollaborationMode: (mode: CodexCollaborationMode) => Promise<void>
    setCopilotAgentMode: (mode: CopilotAgentMode) => Promise<void>
    setModel: (model: { provider: string; modelId: string } | string | null) => Promise<void>
    setModelReasoningEffort: (modelReasoningEffort: string | null) => Promise<void>
    setEffort: (effort: string | null) => Promise<void>
    setServiceTier: (serviceTier: string | null) => Promise<void>
    renameSession: (name: string) => Promise<void>
    suggestSessionTitle: () => Promise<string>
    updateSessionSummary: (text: string) => Promise<void>
    setPinMode: (mode: 'none' | 'project' | 'global') => Promise<void>
    deleteSession: () => Promise<void>
    isPending: boolean
} {
    const queryClient = useQueryClient()

    const markSessionActiveInCache = (targetSessionId: string) => {
        // 中文注释：恢复/重开接口成功后，session-alive SSE 可能已经先到或稍后才到。
        // 这里先乐观更新详情和侧边栏摘要，避免 UI 在下一次 SSE/REST 前仍显示离线。
        queryClient.setQueryData<SessionResponse | undefined>(queryKeys.session(targetSessionId), (previous) => {
            if (!previous?.session) return previous
            return {
                ...previous,
                session: {
                    ...previous.session,
                    active: true,
                    activeAt: Math.max(previous.session.activeAt ?? 0, Date.now())
                }
            }
        })
        queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
            if (!previous) return previous
            let changed = false
            const sessions = previous.sessions.map((summary) => {
                if (summary.id !== targetSessionId) return summary
                changed = true
                return {
                    ...summary,
                    active: true,
                    activeAt: Math.max(summary.activeAt ?? 0, Date.now())
                }
            })
            return changed ? { ...previous, sessions } : previous
        })
    }

    const invalidateSession = async () => {
        if (!sessionId) return
        await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    // Session settings (permission, model, effort, ...) show the new value at
    // once. The hub broadcasts the applied session over SSE, so a successful
    // change needs no refetch; a failed one restores the previous value.
    type SettingsContext = { previous: SessionResponse | undefined }
    const applySettingsOptimistically = async (fields: Partial<SessionResponse['session']>): Promise<SettingsContext> => {
        if (!sessionId) return { previous: undefined }
        const key = queryKeys.session(sessionId)
        await queryClient.cancelQueries({ queryKey: key })
        const previous = queryClient.getQueryData<SessionResponse>(key)
        if (previous?.session) {
            queryClient.setQueryData<SessionResponse>(key, { ...previous, session: { ...previous.session, ...fields } })
        }
        return { previous }
    }
    const rollbackSettings = (context: SettingsContext | undefined) => {
        if (!sessionId) return
        if (context?.previous) {
            queryClient.setQueryData(queryKeys.session(sessionId), context.previous)
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
    }

    const invalidateCursorModels = async () => {
        if (!sessionId || agentFlavor !== 'cursor') return
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessionCursorModels(sessionId) })
        await queryClient.invalidateQueries({ queryKey: ['machine-cursor-models'] })
    }

    const abortMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.abortSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const archiveMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.archiveSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const reopenMutation = useMutation<ReopenSessionResponse, Error, void>({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.reopenSession(sessionId)
        },
        onSuccess: (result) => {
            void (async () => {
                // When reopen merges into a different id, the source detail may
                // already be gone. Invalidating it while still on the source
                // route races with draft handoff and flashes "Session unavailable".
                if (result.sessionId === sessionId) {
                    await invalidateSession()
                } else {
                    await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                }
                markSessionActiveInCache(result.sessionId)
            })()
        },
    })

    const switchMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.switchSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const permissionMutation = useMutation({
        mutationFn: async (mode: PermissionMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (isKnownFlavor(agentFlavor) && !isPermissionModeAllowedForFlavor(mode, agentFlavor)) {
                throw new Error('Invalid permission mode for session flavor')
            }
            await api.setPermissionMode(sessionId, mode)
        },
        onMutate: (mode) => applySettingsOptimistically({ permissionMode: mode }),
        onError: (_error, _variables, context) => rollbackSettings(context),
    })

    const collaborationMutation = useMutation({
        mutationFn: async (mode: CodexCollaborationMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (agentFlavor !== 'codex') {
                throw new Error('Collaboration mode is only supported for Codex sessions')
            }
            if (!codexCollaborationModeSupported) {
                throw new Error('Collaboration mode is only supported for remote Codex sessions')
            }
            await api.setCollaborationMode(sessionId, mode)
        },
        onMutate: (mode) => applySettingsOptimistically({ collaborationMode: mode }),
        onError: (_error, _variables, context) => rollbackSettings(context),
    })

    const copilotAgentModeMutation = useMutation({
        mutationFn: async (mode: CopilotAgentMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (agentFlavor !== 'copilot') {
                throw new Error('Agent mode is only supported for Copilot sessions')
            }
            await api.setCopilotAgentMode(sessionId, mode)
        },
        onMutate: (mode) => applySettingsOptimistically({ copilotAgentMode: mode }),
        onError: (_error, _variables, context) => rollbackSettings(context),
    })

    const modelMutation = useMutation({
        mutationKey: sessionModelMutationKey(sessionId ?? ''),
        mutationFn: async (model: { provider: string; modelId: string } | string | null) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setModel(sessionId, model)
        },
        onMutate: (model) => applySettingsOptimistically({ model: model !== null && typeof model === 'object' ? model.modelId : model }),
        onError: (_error, _variables, context) => rollbackSettings(context),
        onSuccess: () => void invalidateCursorModels(),
    })

    const modelReasoningEffortMutation = useMutation({
        mutationFn: async (modelReasoningEffort: string | null) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (agentFlavor !== 'codex' && agentFlavor !== 'opencode') {
                throw new Error('Model reasoning effort is only supported for Codex and OpenCode sessions')
            }
            if (agentFlavor === 'codex' && !codexCollaborationModeSupported) {
                throw new Error('Model reasoning effort is only supported for remote sessions')
            }
            await api.setModelReasoningEffort(sessionId, modelReasoningEffort)
        },
        onMutate: (modelReasoningEffort) => applySettingsOptimistically({ modelReasoningEffort }),
        onError: (_error, _variables, context) => rollbackSettings(context),
    })

    const effortMutation = useMutation({
        mutationFn: async (effort: string | null) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setEffort(sessionId, effort)
        },
        onMutate: (effort) => applySettingsOptimistically({ effort }),
        onError: (_error, _variables, context) => rollbackSettings(context),
    })

    const serviceTierMutation = useMutation({
        mutationFn: async (serviceTier: string | null) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (agentFlavor !== 'codex') {
                throw new Error('Fast mode is only supported for Codex sessions')
            }
            if (!codexCollaborationModeSupported) {
                throw new Error('Fast mode is only supported for remote sessions')
            }
            await api.setServiceTier(sessionId, serviceTier)
        },
        onMutate: (serviceTier) => applySettingsOptimistically({ serviceTier }),
        onError: (_error, _variables, context) => rollbackSettings(context),
    })

    const renameMutation = useMutation({
        mutationFn: async (name: string) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.renameSession(sessionId, name)
        },
        onSuccess: () => void invalidateSession(),
    })

    const titleSuggestionMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const response = await api.suggestSessionTitle(sessionId)
            return response.title
        }
    })

    const summaryMutation = useMutation({
        mutationFn: async (text: string) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.updateSessionSummary(sessionId, text)
        },
        onSuccess: () => void invalidateSession(),
    })

    const pinMutation = useMutation({
        mutationFn: async (mode: 'none' | 'project' | 'global') => {
            if (!api || !sessionId) throw new Error('Session unavailable')
            await api.setSessionPinMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const deleteMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.deleteSession(sessionId)
        },
        onSuccess: async () => {
            if (!sessionId) return
            queryClient.removeQueries({ queryKey: queryKeys.session(sessionId) })
            clearMessageWindow(sessionId)
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    return {
        abortSession: abortMutation.mutateAsync,
        archiveSession: archiveMutation.mutateAsync,
        reopenSession: reopenMutation.mutateAsync,
        switchSession: switchMutation.mutateAsync,
        setPermissionMode: permissionMutation.mutateAsync,
        setCollaborationMode: collaborationMutation.mutateAsync,
        setCopilotAgentMode: copilotAgentModeMutation.mutateAsync,
        setModel: modelMutation.mutateAsync,
        setModelReasoningEffort: modelReasoningEffortMutation.mutateAsync,
        setEffort: effortMutation.mutateAsync,
        setServiceTier: serviceTierMutation.mutateAsync,
        renameSession: renameMutation.mutateAsync,
        suggestSessionTitle: titleSuggestionMutation.mutateAsync,
        updateSessionSummary: summaryMutation.mutateAsync,
        setPinMode: pinMutation.mutateAsync,
        deleteSession: deleteMutation.mutateAsync,
        isPending: abortMutation.isPending
            || archiveMutation.isPending
            || reopenMutation.isPending
            || switchMutation.isPending
            || permissionMutation.isPending
            || collaborationMutation.isPending
            || copilotAgentModeMutation.isPending
            || modelMutation.isPending
            || modelReasoningEffortMutation.isPending
            || effortMutation.isPending
            || serviceTierMutation.isPending
            || renameMutation.isPending
            || titleSuggestionMutation.isPending
            || summaryMutation.isPending
            || pinMutation.isPending
            || deleteMutation.isPending,
    }
}
