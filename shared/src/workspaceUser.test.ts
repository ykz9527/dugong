import { describe, expect, it } from 'bun:test'
import { isOwnedByWorkspaceUser, isPathOwnedBy, normalizeWorkspacePath } from './workspaceUser'

describe('normalizeWorkspacePath', () => {
    it('drops trailing slashes but keeps root', () => {
        expect(normalizeWorkspacePath('/home/alice/proj/')).toBe('/home/alice/proj')
        expect(normalizeWorkspacePath('  /home/alice/proj  ')).toBe('/home/alice/proj')
        expect(normalizeWorkspacePath('/')).toBe('/')
    })

    it('resolves dot segments, doubled slashes and backslashes', () => {
        expect(normalizeWorkspacePath('/home/alice/../bob/repo')).toBe('/home/bob/repo')
        expect(normalizeWorkspacePath('/home//alice/./repo')).toBe('/home/alice/repo')
        expect(normalizeWorkspacePath('/../..')).toBe('/')
        expect(normalizeWorkspacePath('C:\\Users\\alice\\repo\\')).toBe('C:/Users/alice/repo')
    })
})

describe('isPathOwnedBy', () => {
    const roots = ['/home/alice/src/repo']

    it('claims the root itself and anything under it', () => {
        expect(isPathOwnedBy('/home/alice/src/repo', roots)).toBe(true)
        expect(isPathOwnedBy('/home/alice/src/repo/web/src', roots)).toBe(true)
        expect(isPathOwnedBy('/home/alice/src/repo/', roots)).toBe(true)
    })

    it('does not claim a sibling that merely shares a prefix', () => {
        // The bug this guards: `repo-worktrees` starts with `repo`.
        expect(isPathOwnedBy('/home/alice/src/repo-worktrees/0902', roots)).toBe(false)
        expect(isPathOwnedBy('/home/alice/src/repo2', roots)).toBe(false)
    })

    it('does not let `..` climb out of a root', () => {
        expect(isPathOwnedBy('/home/alice/src/repo/../../../bob/repo', roots)).toBe(false)
        expect(isPathOwnedBy('/home/alice/src/repo/web/../cli', roots)).toBe(true)
        expect(isPathOwnedBy('/home/alice/src/other/../repo/x', roots)).toBe(true)
    })

    it('owns nothing when no roots are configured', () => {
        expect(isPathOwnedBy('/home/alice/anything', [])).toBe(false)
    })

    it('treats a missing path as unowned', () => {
        expect(isPathOwnedBy(null, roots)).toBe(false)
        expect(isPathOwnedBy(undefined, roots)).toBe(false)
        expect(isPathOwnedBy('', roots)).toBe(false)
    })
})

describe('isOwnedByWorkspaceUser', () => {
    const roots = ['/home/alice/src/repo']

    it('matches on any of the candidate paths', () => {
        // A worktree checkout beside the repo: only the source repo matches,
        // and that is enough for the card to be Alice's.
        expect(isOwnedByWorkspaceUser(
            ['/home/alice/src/repo-worktrees/0902', '/home/alice/src/repo'],
            roots
        )).toBe(true)
    })

    it('is false when nothing matches', () => {
        expect(isOwnedByWorkspaceUser(['/home/bob/proj', null], roots)).toBe(false)
    })

    it('supports several roots', () => {
        expect(isOwnedByWorkspaceUser(
            ['/home/alice/src/other/cli'],
            ['/home/alice/src/repo', '/home/alice/src/other']
        )).toBe(true)
    })
})
