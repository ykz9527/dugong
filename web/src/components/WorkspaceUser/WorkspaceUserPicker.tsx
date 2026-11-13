import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { useActiveWorkspaceUser } from '@/hooks/queries/useWorkspaceUsers'
import { useSwitchWorkspaceUser } from '@/hooks/useWorkspaceUserScope'
import { WorkspaceUserDialog } from './WorkspaceUserDialog'

const MANAGE_VALUE = '__manage__'

/**
 * "Whose work am I looking at?" — one control, identical in the task list and
 * in the session list.
 *
 * Managing the list is folded into the same select rather than given its own
 * button. The list is edited once and then read for months; a permanent button
 * next to it would spend that whole time competing with the choice that
 * actually gets made every day.
 */
export function WorkspaceUserPicker(props: {
    api: ApiClient | null
    /** Render nothing until somebody has been defined. The session list opts in
     *  to this so a hub that never uses the feature is not given a header row it
     *  does not need; the task list always shows the control, because that is where
     *  the first user has to be created from. */
    hideWhenEmpty?: boolean
    className?: string
}) {
    const { t } = useTranslation()
    const { activeId, workspaceUsers } = useActiveWorkspaceUser(props.api)
    const { machines } = useMachines(props.api, true)
    const switchUser = useSwitchWorkspaceUser()
    const [managing, setManaging] = useState(false)

    if (props.hideWhenEmpty && workspaceUsers.length === 0) {
        return null
    }

    // A selection whose user was deleted elsewhere would otherwise render as a
    // blank select while the hub still 404s the scope behind it.
    const value = activeId && workspaceUsers.some((user) => user.id === activeId) ? activeId : ''

    return (
        <>
            <select
                aria-label={t('workspaceUser.filterLabel')}
                title={t('workspaceUser.filterLabel')}
                value={value}
                onChange={(event) => {
                    const next = event.target.value
                    if (next === MANAGE_VALUE) {
                        setManaging(true)
                        return
                    }
                    switchUser(next === '' ? null : next)
                }}
                className={props.className ?? 'rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent py-1 text-[15px] text-[var(--app-fg)]'}
            >
                <option value="">{t('workspaceUser.everyone')}</option>
                {workspaceUsers.map((user) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                ))}
                <option value={MANAGE_VALUE}>{t('workspaceUser.manage')}</option>
            </select>

            {managing ? (
                <WorkspaceUserDialog
                    api={props.api}
                    machines={machines}
                    onClose={() => setManaging(false)}
                />
            ) : null}
        </>
    )
}
