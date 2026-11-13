import type { SessionSummary } from '@/types/api'

/**
 * The project a session belongs to.
 *
 * A board task runs in its own git worktree, so its `path` is
 * `…/repo-worktrees/0821-abcd` — a different string for every task on the same
 * repo. Grouping on that would scatter one project's work across as many
 * buckets as it has tasks, which is the opposite of what the sidebar is for.
 * `worktree.basePath` is the repo those worktrees came from, so it is the
 * identity that actually matters here.
 *
 * This mirrors the key `groupSessionsByDirectory` already builds; it is
 * extracted so the project scope filter and the directory groups cannot drift
 * apart.
 */
export function getSessionProjectPath(session: SessionSummary): string | null {
    return session.metadata?.worktree?.basePath ?? session.metadata?.path ?? null
}

/** Last path segment — what a human calls the project. */
export function getProjectLabel(path: string): string {
    const parts = path.split(/[\\/]+/).filter(Boolean)
    return parts[parts.length - 1] ?? path
}

/**
 * Sessions that share a project with `selectedSessionId`.
 *
 * The selected session always survives: a sidebar that hides the row you are
 * reading is worse than one that shows too much. Sessions with no resolvable
 * path are kept too — dropping a session because its metadata is thin would
 * make it unreachable.
 */
export function filterSessionsInProject(
    sessions: SessionSummary[],
    projectPath: string | null,
    selectedSessionId?: string | null
): SessionSummary[] {
    if (!projectPath) return sessions
    return sessions.filter((session) => {
        if (session.id === selectedSessionId) return true
        const path = getSessionProjectPath(session)
        return path === null || path === projectPath
    })
}

/** How many distinct projects are represented — the scope bar is pointless at one. */
export function countProjects(sessions: SessionSummary[]): number {
    const seen = new Set<string>()
    for (const session of sessions) {
        const path = getSessionProjectPath(session)
        if (path) seen.add(path)
    }
    return seen.size
}
