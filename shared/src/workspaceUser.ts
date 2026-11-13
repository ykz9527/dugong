import { z } from 'zod'

/**
 * Workspace users — "whose work is this?" for the board and the session list.
 *
 * Not an identity and not a permission boundary. A hub is shared by several
 * people who each work out of their own directories; without a way to say
 * which directories are whose, every board and every session list shows
 * everyone's work at once, and the one card that matters is buried under
 * fifty that do not.
 *
 * So a workspace user is a *name plus a set of root paths*. Anything running
 * under one of those roots belongs to them. That is deliberately the cheapest
 * possible answer: the machine already records where every session and every
 * task runs, so nothing has to be tagged, migrated, or kept in sync — the
 * directory a person works in is already the fact that separates them.
 *
 * Deliberately NOT the existing `users` table: that one maps a Telegram
 * account onto a namespace and is about authentication. This is about view
 * scoping within one namespace, and the two must be free to disagree.
 */

export const WORKSPACE_USER_NAME_MAX_LENGTH = 60
export const WORKSPACE_USER_MAX_PATHS = 20

export const WorkspaceUserSchema = z.object({
    id: z.string(),
    namespace: z.string(),
    name: z.string(),
    /**
     * Root directories owned by this user. A path matches if it *is* a root or
     * sits under one. Empty means the user owns nothing yet — they see an
     * empty board rather than everything, because "not configured" and
     * "owns the whole hub" are very different claims and only one of them is
     * ever what the operator meant.
     */
    paths: z.array(z.string()),
    createdAt: z.number(),
    updatedAt: z.number()
})

export type WorkspaceUser = z.infer<typeof WorkspaceUserSchema>

/**
 * One spelling per directory, so prefix matching cannot be fooled: forward
 * slashes, no `.`/`..` segments (`/home/a/../b` is `/home/b`, not under
 * `/home/a`), no doubled or trailing slashes. Written out rather than taken
 * from `node:path` because the web bundle runs this too.
 */
export function normalizeWorkspacePath(path: string): string {
    const trimmed = path.trim().replace(/\\/g, '/')
    if (!trimmed) return ''
    const absolute = trimmed.startsWith('/')
    const segments: string[] = []
    for (const segment of trimmed.split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') {
            if (segments.length > 0 && segments[segments.length - 1] !== '..') {
                segments.pop()
            } else if (!absolute) {
                segments.push('..')
            }
            continue
        }
        segments.push(segment)
    }
    const joined = segments.join('/')
    if (absolute) return `/${joined}`
    return joined || '.'
}

/**
 * Does `path` sit inside one of `roots`?
 *
 * Prefix matching on a path separator, so `/home/a/proj` claims
 * `/home/a/proj/src` but not the sibling `/home/a/project`. No roots means no
 * match — see `WorkspaceUserSchema.paths`.
 */
export function isPathOwnedBy(path: string | null | undefined, roots: readonly string[]): boolean {
    if (!path) return false
    const candidate = normalizeWorkspacePath(path)
    return roots.some((root) => {
        const normalized = normalizeWorkspacePath(root)
        if (!normalized) return false
        if (candidate === normalized) return true
        return candidate.startsWith(normalized === '/' ? '/' : `${normalized}/`)
    })
}

/**
 * Ownership over every path a piece of work touches.
 *
 * Any hit wins, and that is the point for worktrees: a worktree checkout
 * usually lives *beside* the repo it came from (`repo-worktrees/0902` next to
 * `repo`), so matching only the working directory would hand a card to
 * nobody. The source repo is carried alongside it precisely so the card can
 * still be traced back to whoever owns that repo.
 */
export function isOwnedByWorkspaceUser(
    paths: ReadonlyArray<string | null | undefined>,
    roots: readonly string[]
): boolean {
    return paths.some((path) => isPathOwnedBy(path, roots))
}
