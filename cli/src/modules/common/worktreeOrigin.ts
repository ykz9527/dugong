import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorktreeMetadata } from '@hapi/protocol/types'

/**
 * Where a directory came from, when it is a git worktree.
 *
 * Adopted sessions need this for the same reason spawned ones record it:
 * workspace ownership is decided by path, and a worktree checkout sits
 * *beside* the repo rather than inside it — `foo-worktrees/0902` does not
 * match a claim on `foo`. Without the origin, a session adopted from a
 * worktree belongs to nobody and disappears from every filtered view.
 *
 * Read off disk rather than shelled out to git: this runs per adopted session
 * on a listing path, and the two files involved say everything `git` would.
 */

/** How far up from the working directory to look for the worktree root. */
const MAX_PARENT_LOOKUPS = 5

const GIT_WORKTREE_MARKER = '/.git/worktrees/'

/**
 * What the `.git` entry in a directory says: nothing there (keep walking up),
 * a normal checkout's `.git` directory, or a worktree/submodule `.git` file
 * with the gitdir it points at (null when unreadable).
 */
function readDotGit(directory: string): { kind: 'none' } | { kind: 'repo' } | { kind: 'pointer'; gitdir: string | null } {
    const dotGit = join(directory, '.git')
    let isFile: boolean
    try {
        isFile = statSync(dotGit).isFile()
    } catch {
        return { kind: 'none' }
    }
    // A worktree's `.git` is a file pointing elsewhere; a normal checkout's
    // is a directory, and a normal checkout has no origin to report.
    if (!isFile) return { kind: 'repo' }
    try {
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf-8'))
        return { kind: 'pointer', gitdir: match ? match[1].trim() : null }
    } catch {
        return { kind: 'pointer', gitdir: null }
    }
}

function branchAt(gitdir: string): string | null {
    try {
        const head = readFileSync(join(gitdir, 'HEAD'), 'utf-8').trim()
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
        // Detached HEAD has no branch to name; the short sha is what git itself
        // shows in that state.
        return ref ? ref[1] : (head ? head.slice(0, 12) : null)
    } catch {
        return null
    }
}

export function detectWorktreeOrigin(workingDirectory: string): WorktreeMetadata | null {
    let directory = workingDirectory
    // Claude may have been started below the worktree root, so walk up until
    // the pointer turns up or the walk leaves anything plausible behind.
    for (let depth = 0; depth <= MAX_PARENT_LOOKUPS; depth += 1) {
        const dotGit = readDotGit(directory)
        // The nearest repo wins: a plain repo nested inside a worktree is
        // that repo, not the worktree around it.
        if (dotGit.kind === 'repo') return null
        if (dotGit.kind === 'pointer') {
            const gitdir = dotGit.gitdir
            if (!gitdir) return null
            const marker = gitdir.lastIndexOf(GIT_WORKTREE_MARKER)
            if (marker === -1) return null
            const basePath = gitdir.slice(0, marker)
            const name = gitdir.slice(marker + GIT_WORKTREE_MARKER.length)
            if (!basePath || !name) return null
            return {
                basePath,
                name,
                branch: branchAt(gitdir) ?? name,
                worktreePath: directory
            }
        }
        const parent = dirname(directory)
        if (parent === directory) return null
        directory = parent
    }
    return null
}
