import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateWorkspaceUserRequest, UpdateWorkspaceUserRequest } from '@hapi/protocol/apiTypes'
import type { WorkspaceUser } from '@hapi/protocol'
import { readableError, type ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { getActiveWorkspaceUserId, setActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'

/**
 * Workspace user writes.
 *
 * Every one of them invalidates the board and the session list as well as the
 * user list: editing a person's paths silently changes what both views are
 * allowed to show, and leaving stale rows on screen would misattribute work.
 */
export function useWorkspaceUserActions(api: ApiClient | null): {
    createWorkspaceUser: (input: CreateWorkspaceUserRequest) => Promise<WorkspaceUser>
    updateWorkspaceUser: (input: { id: string; patch: UpdateWorkspaceUserRequest }) => Promise<WorkspaceUser>
    deleteWorkspaceUser: (id: string) => Promise<void>
    isPending: boolean
    error: string | null
} {
    const queryClient = useQueryClient()

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceUsers })
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks })
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const create = useMutation({
        mutationFn: async (input: CreateWorkspaceUserRequest) => {
            if (!api) throw new Error('API unavailable')
            const response = await api.createWorkspaceUser(input)
            return response.workspaceUser
        },
        onSuccess: invalidate
    })

    const update = useMutation({
        mutationFn: async (input: { id: string; patch: UpdateWorkspaceUserRequest }) => {
            if (!api) throw new Error('API unavailable')
            const response = await api.updateWorkspaceUser(input.id, input.patch)
            return response.workspaceUser
        },
        onSuccess: invalidate
    })

    const remove = useMutation({
        mutationFn: async (id: string) => {
            if (!api) throw new Error('API unavailable')
            await api.deleteWorkspaceUser(id)
            return id
        },
        onSuccess: (id) => {
            // Deleting the user you are currently looking through has to drop
            // the lens too, or every list 404s on a scope the hub no longer has.
            if (getActiveWorkspaceUserId() === id) {
                setActiveWorkspaceUserId(null)
            }
            invalidate()
        }
    })

    const firstError = create.error ?? update.error ?? remove.error

    return {
        createWorkspaceUser: create.mutateAsync,
        updateWorkspaceUser: update.mutateAsync,
        deleteWorkspaceUser: async (id: string) => {
            await remove.mutateAsync(id)
        },
        isPending: create.isPending || update.isPending || remove.isPending,
        error: firstError ? readableError(firstError) : null
    }
}
