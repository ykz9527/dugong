import { isOwnedByWorkspaceUser } from '@hapi/protocol'
import type { Context } from 'hono'
import type { Store, StoredTask } from '../../store'
import type { Session } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

/**
 * The `?workspaceUser=<id>` scope shared by the board and the session list.
 *
 * Both views answer the same question — "is this mine?" — from the same two
 * facts: the directory the work runs in, and the roots one person has claimed.
 * Resolving it here rather than in each route is what keeps a card visible on
 * the board only when its session is also visible in the list; two copies of
 * this rule would eventually disagree, and a board that shows a task whose
 * conversation you cannot open is worse than no filter at all.
 *
 * Absent parameter means no scoping — that is the pre-existing behaviour and
 * still what an operator who has not picked a user should see.
 */
export type WorkspaceScope = { roots: readonly string[] } | null

export function resolveWorkspaceScope(
    c: Context<WebAppEnv>,
    store: Store,
    rawId: string | undefined
): WorkspaceScope | Response {
    if (rawId === undefined || rawId === '') return null

    const row = store.workspaceUsers.get(rawId, c.get('namespace'))
    if (!row) {
        // Deleted out from under a browser that still had them selected. A 404
        // is what lets the web app clear the stale selection instead of
        // silently showing it everything again.
        return c.json({ error: 'Workspace user not found', code: 'workspace_user_not_found' }, 404)
    }
    return { roots: row.paths }
}

/**
 * A task belongs to whoever owns its source repo or its checkout.
 *
 * Both are checked because they routinely live apart: `isolation: 'worktree'`
 * puts the checkout in a sibling directory of the repo, and only one of the
 * two will sit under the root the operator actually claimed.
 */
export function taskInScope(task: StoredTask, scope: WorkspaceScope): boolean {
    if (!scope) return true
    return isOwnedByWorkspaceUser([task.workdir, task.worktreePath], scope.roots)
}

/** Same rule for a session: its working directory, or the repo it forked from. */
export function sessionInScope(session: Session, scope: WorkspaceScope): boolean {
    if (!scope) return true
    const metadata = session.metadata
    return isOwnedByWorkspaceUser(
        [metadata?.path, metadata?.worktree?.basePath, metadata?.worktree?.worktreePath],
        scope.roots
    )
}
