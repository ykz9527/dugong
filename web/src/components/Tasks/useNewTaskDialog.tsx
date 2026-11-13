import { useState, type ReactNode } from 'react'
import type { CreateTaskRequest } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { useMachines } from '@/hooks/queries/useMachines'
import { useActiveWorkspaceUser } from '@/hooks/queries/useWorkspaceUsers'
import { useTaskActions, type AdoptTaskInput } from '@/hooks/mutations/useTaskActions'
import { NewTaskDialog } from './NewTaskDialog'

/** Where a composer opened from a folder starts. */
export type NewTaskDialogInitial = {
    workdir?: string
    machineId?: string
}

/**
 * The new-task composer.
 *
 * The sidebar and the folder browser both open it, and it has to be
 * the same composer everywhere: what the dialog asks, how a failed create keeps
 * the prompt, and how adopting a session is chained are decisions about the
 * task, not about where the button happens to sit.
 */
export function useNewTaskDialog(
    api: ApiClient | null,
    options?: { onCreated?: () => void }
): {
    open: (initial?: NewTaskDialogInitial) => void
    dialog: ReactNode
} {
    const [isOpen, setIsOpen] = useState(false)
    const [initial, setInitial] = useState<NewTaskDialogInitial | undefined>(undefined)
    // The task was made but its start failed. Kept in the dialog: the task
    // exists, so it must not be submitted again, and nothing else would say
    // why it is not running.
    const [startFailure, setStartFailure] = useState<string | null>(null)
    const { machines } = useMachines(api, true)
    const { activeUser } = useActiveWorkspaceUser(api)
    // Its own mutation set, so a create that failed is reported inside the
    // dialog and nowhere else — the host's error line stays about the host's
    // own actions.
    const actions = useTaskActions(api)

    const handleCreate = async (input: CreateTaskRequest) => {
        try {
            const created = await actions.createTask(input)
            if (created.start && created.start.outcome !== 'started') {
                setStartFailure(created.start.message ?? created.start.outcome)
                return
            }
            setIsOpen(false)
            options?.onCreated?.()
        } catch {
            // Kept open so the operator does not lose the prompt they typed;
            // the reason is rendered inside the dialog.
        }
    }

    const handleAdopt = async (input: AdoptTaskInput) => {
        try {
            await actions.adoptTask(input)
            setIsOpen(false)
            options?.onCreated?.()
        } catch {
            // Same as create: the dialog stays open and renders the reason,
            // rather than dropping the session the operator just picked.
        }
    }

    return {
        open: (next) => {
            // A failure from the last time it was open is not about this one.
            actions.reset()
            setStartFailure(null)
            setInitial(next)
            setIsOpen(true)
        },
        dialog: isOpen ? (
            <NewTaskDialog
                machines={machines}
                initialWorkdir={initial?.workdir}
                initialMachineId={initial?.machineId}
                userPaths={activeUser?.paths ?? []}
                isPending={actions.isPending}
                error={actions.error}
                startFailure={startFailure}
                onSubmit={(input) => void handleCreate(input)}
                onAdopt={(input) => void handleAdopt(input)}
                onClose={() => {
                    setIsOpen(false)
                    if (startFailure !== null) options?.onCreated?.()
                }}
            />
        ) : null
    }
}
