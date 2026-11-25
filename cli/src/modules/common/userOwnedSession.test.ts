import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isSessionOwnedByUser } from './userOwnedSession'

describe('isSessionOwnedByUser', () => {
    const roots: string[] = []
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    it('owns the repo, the runner\'s worktrees beside it, and nothing that only looks alike', () => {
        const repo = '/home/kai/pitwall'
        expect(isSessionOwnedByUser('/home/kai/pitwall/web', [repo])).toBe(true)
        expect(isSessionOwnedByUser('/home/kai/pitwall-worktrees/1124-ab12', [repo])).toBe(true)
        // Same encoded prefix in Claude's project directory names, other repo.
        expect(isSessionOwnedByUser('/home/kai/pitwall-foo', [repo])).toBe(false)
        expect(isSessionOwnedByUser(null, [repo])).toBe(false)
    })

    it('traces a worktree elsewhere back to its repo', () => {
        const base = mkdtempSync(join(tmpdir(), 'owned-'))
        roots.push(base)
        const repo = join(base, 'repo')
        const checkout = join(base, 'elsewhere', 'wt')
        mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
        writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature\n')
        mkdirSync(checkout, { recursive: true })
        writeFileSync(join(checkout, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`)

        expect(isSessionOwnedByUser(checkout, [repo])).toBe(true)
        expect(isSessionOwnedByUser(checkout, [join(base, 'other')])).toBe(false)
    })
})
