import type { ApiClient } from '@/api/client'
import { useSession } from '@/hooks/queries/useSession'
import { useTask } from '@/hooks/queries/useTasks'
import { TaskDetail } from './TaskDetail'
import type { useTaskLifecycle } from './useTaskLifecycle'

/**
 * The detail panel for one task, wired to a host's lifecycle.
 *
 * The list does not carry run history, so the panel fetches the task itself.
 */
export function TaskDetailPanel(props: {
    api: ApiClient | null
    taskId: string
    lifecycle: ReturnType<typeof useTaskLifecycle>
    onClose: () => void
    onNavigate?: () => void
}) {
    const { lifecycle } = props
    const detailQuery = useTask(props.api, props.taskId)
    const task = detailQuery.data?.task ?? null
    // The pending-approval list lives on the session, not the task.
    const { session } = useSession(props.api, task?.currentSessionId ?? null)

    if (!task) return null

    return (
        <TaskDetail
            api={props.api}
            task={task}
            runs={detailQuery.data?.runs ?? []}
            session={session}
            isBusy={lifecycle.actions.isPending}
            onStart={lifecycle.start}
            onCancel={lifecycle.cancel}
            onMove={lifecycle.move}
            onRename={lifecycle.rename}
            onArchive={lifecycle.archive}
            onUnarchive={lifecycle.unarchive}
            onDelete={(taskId, options) => {
                // A deleted task has nothing left to show; a refused one stays
                // open so its second press is still in reach.
                void lifecycle.remove(taskId, options).then((removed) => {
                    if (removed) props.onClose()
                })
            }}
            dirtyWarning={lifecycle.dirtyWarnings[task.id] ?? null}
            error={lifecycle.actions.error}
            onOpenPullRequest={lifecycle.openPullRequest}
            onRefreshPullRequest={lifecycle.refreshPullRequest}
            onClose={props.onClose}
            onNavigate={props.onNavigate}
        />
    )
}
