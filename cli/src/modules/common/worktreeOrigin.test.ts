import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectWorktreeOrigin } from './worktreeOrigin'

describe('detectWorktreeOrigin', () => {
    const roots: string[] = []

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    /** A checkout laid out the way `git worktree add` leaves one. */
    function makeWorktree(options: { branch?: string; head?: string } = {}): {
        repo: string
        worktree: string
    } {
        const root = mkdtempSync(join(tmpdir(), 'worktree-origin-'))
        roots.push(root)
        const repo = join(root, 'proj')
        const worktree = join(root, 'proj-worktrees', 'feature')
        const gitdir = join(repo, '.git', 'worktrees', 'feature')
        mkdirSync(gitdir, { recursive: true })
        mkdirSync(worktree, { recursive: true })
        writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`)
        writeFileSync(join(gitdir, 'HEAD'), options.head ?? `ref: refs/heads/${options.branch ?? 'topic'}\n`)
        return { repo, worktree }
    }

    it('reports the repo a worktree came from', () => {
        // This is the whole point: ownership matches on paths, and the checkout
        // sits beside the repo rather than under it.
        const { repo, worktree } = makeWorktree({ branch: 'topic' })

        expect(detectWorktreeOrigin(worktree)).toEqual({
            basePath: repo,
            name: 'feature',
            branch: 'topic',
            worktreePath: worktree
        })
    })

    it('finds the root from a directory inside the worktree', () => {
        // Nothing says the agent was started at the top of the checkout.
        const { repo, worktree } = makeWorktree()
        const nested = join(worktree, 'packages', 'cli')
        mkdirSync(nested, { recursive: true })

        expect(detectWorktreeOrigin(nested)?.basePath).toBe(repo)
    })

    it('names a detached checkout by its commit', () => {
        const { worktree } = makeWorktree({ head: '9f1c2b3a4d5e6f78901234567890abcdef123456\n' })

        expect(detectWorktreeOrigin(worktree)?.branch).toBe('9f1c2b3a4d5e')
    })

    it('reports nothing for an ordinary checkout', () => {
        // A normal repo's `.git` is a directory, and it has no origin to name —
        // its own path is already what ownership matches on.
        const root = mkdtempSync(join(tmpdir(), 'worktree-origin-'))
        roots.push(root)
        mkdirSync(join(root, '.git'), { recursive: true })

        expect(detectWorktreeOrigin(root)).toBeNull()
    })

    it('reports nothing for a plain repo nested inside a worktree', () => {
        const { worktree } = makeWorktree()
        const nestedRepo = join(worktree, 'vendor', 'plain')
        mkdirSync(join(nestedRepo, '.git'), { recursive: true })

        expect(detectWorktreeOrigin(nestedRepo)).toBeNull()
        mkdirSync(join(nestedRepo, 'src'), { recursive: true })
        expect(detectWorktreeOrigin(join(nestedRepo, 'src'))).toBeNull()
    })

    it('reports nothing outside git', () => {
        const root = mkdtempSync(join(tmpdir(), 'worktree-origin-'))
        roots.push(root)

        expect(detectWorktreeOrigin(root)).toBeNull()
    })

    it('ignores a gitdir pointer that is not a worktree', () => {
        // Submodules also use a `.git` file, and a submodule's parent repo is
        // not the answer to this question.
        const root = mkdtempSync(join(tmpdir(), 'worktree-origin-'))
        roots.push(root)
        const submodule = join(root, 'vendor', 'lib')
        mkdirSync(submodule, { recursive: true })
        writeFileSync(join(submodule, '.git'), `gitdir: ${join(root, '.git', 'modules', 'vendor', 'lib')}\n`)

        expect(detectWorktreeOrigin(submodule)).toBeNull()
    })
})
