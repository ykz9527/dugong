import { isPathOwnedBy, normalizeWorkspacePath } from '@hapi/protocol'
import { detectWorktreeOrigin } from './worktreeOrigin'

/**
 * Whether a session run in `cwd` belongs to a workspace user with `roots`.
 *
 * The same answer the board gives for a task: under one of the roots, or a
 * worktree of a repo under one. Worktrees matter because they sit *beside*
 * the repo: the runner puts `repo`'s in `repo-worktrees/<id>`, which no claim
 * on `repo` covers by path. That layout is checked by name first; any other
 * worktree is traced to its repo through git's own files.
 */
export function isSessionOwnedByUser(cwd: string | null | undefined, roots: readonly string[]): boolean {
    if (!cwd) return false
    if (isPathOwnedBy(cwd, roots)) return true
    const worktreeDirs = roots
        .map(normalizeWorkspacePath)
        .filter((root) => root && root !== '/')
        .map((root) => `${root}-worktrees`)
    if (isPathOwnedBy(cwd, worktreeDirs)) return true
    const origin = detectWorktreeOrigin(cwd)
    return Boolean(origin && isPathOwnedBy(origin.basePath, roots))
}
