import { isOwnedByWorkspaceUser } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import type { StoredWorkspaceUser } from '../store/types'

/**
 * Which push targets should hear about work happening at a given path.
 *
 * A namespace is a team, not a person: a hub is shared by several people who
 * each work out of their own directories. Addressing a notification to the
 * namespace therefore buzzed every phone paired with it, including the ones
 * whose owner has never touched that session. Each target now records the
 * workspace user its screen is filtered to, and this picks the ones that match.
 */

/**
 * The directories a session runs out of.
 *
 * Same three the board and the session list already match on
 * (`sessionInScope`): a worktree checkout usually sits *beside* the repo it
 * came from, so the working directory alone would leave the session unclaimed
 * by whoever owns that repo.
 */
export function sessionPaths(session: Session): string[] {
    const metadata = session.metadata
    return [metadata?.path, metadata?.worktree?.basePath, metadata?.worktree?.worktreePath]
        .filter((path): path is string => typeof path === 'string' && path.length > 0)
}

/**
 * Who a notification is for: whoever owns these directories, or one named
 * person. The second exists for the task assistant, which runs out of its own
 * directory under DUGONG_HOME — nobody owns that path, but the session is
 * unambiguously one person's.
 */
export type NotificationTargetScope = readonly string[] | { workspaceUserId: string }

export function sessionTargetScope(session: Session): NotificationTargetScope {
    const metadata = session.metadata
    if (metadata?.role === 'assistant' && metadata.workspaceUserId) {
        return { workspaceUserId: metadata.workspaceUserId }
    }
    return sessionPaths(session)
}

function isNamedPerson(scope: NotificationTargetScope): scope is { workspaceUserId: string } {
    return !Array.isArray(scope)
}

/**
 * Does a target filtered to `workspaceUserId` (null: unfiltered) hear about
 * work in `scope`?
 *
 * Two deliberate pass-through cases, both of them "we cannot tell, so do what
 * we did before": a session with no recorded directory, and a target that
 * claims no workspace user — muting a device that never made a claim would be
 * a worse bug than the one this fixes.
 *
 * A target claiming a workspace user that no longer exists is *not* one of
 * them: it gets nothing until its client notices the 404 and re-registers.
 * Deleting a person should not turn their old phone into a firehose.
 */
export function targetMatcher(
    workspaceUsers: readonly StoredWorkspaceUser[],
    scope: NotificationTargetScope | undefined
): (workspaceUserId: string | null | undefined) => boolean {
    if (scope && isNamedPerson(scope)) {
        return (workspaceUserId) => workspaceUserId == null || workspaceUserId === scope.workspaceUserId
    }
    if (!scope || scope.length === 0) {
        return () => true
    }
    const owners = new Set(
        workspaceUsers
            .filter((user) => isOwnedByWorkspaceUser(scope, user.paths))
            .map((user) => user.id)
    )
    return (workspaceUserId) => workspaceUserId == null || owners.has(workspaceUserId)
}

/** Filter push targets down to the ones in scope; see `targetMatcher`. */
export function selectTargetsInScope<T extends { workspaceUserId?: string | null }>(
    targets: readonly T[],
    workspaceUsers: readonly StoredWorkspaceUser[],
    scope: NotificationTargetScope | undefined
): T[] {
    const matches = targetMatcher(workspaceUsers, scope)
    return targets.filter((target) => matches(target.workspaceUserId))
}
