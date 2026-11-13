import { describe, expect, it } from 'bun:test'
import { parseGitRemote } from './parseRemote'
import { resolveGitHostTarget } from './index'

describe('parseGitRemote', () => {
    it('parses https remotes', () => {
        expect(parseGitRemote('https://github.com/acme/widget.git')).toEqual({
            host: 'github.com', owner: 'acme', repo: 'widget'
        })
        expect(parseGitRemote('https://github.com/acme/widget')).toEqual({
            host: 'github.com', owner: 'acme', repo: 'widget'
        })
    })

    it('parses scp-style remotes', () => {
        expect(parseGitRemote('git@github.com:acme/widget.git')).toEqual({
            host: 'github.com', owner: 'acme', repo: 'widget'
        })
    })

    it('parses ssh:// remotes, port and all', () => {
        expect(parseGitRemote('ssh://git@ghe.corp.example:2222/acme/widget.git')).toEqual({
            host: 'ghe.corp.example', owner: 'acme', repo: 'widget'
        })
    })

    it('keeps nested groups in the owner', () => {
        expect(parseGitRemote('https://ghe.corp.example/team/sub/widget.git')).toEqual({
            host: 'ghe.corp.example', owner: 'team/sub', repo: 'widget'
        })
    })

    it('lowercases the host but not the path', () => {
        expect(parseGitRemote('https://GitHub.com/Acme/Widget.git')).toEqual({
            host: 'github.com', owner: 'Acme', repo: 'Widget'
        })
    })

    it('returns null for remotes with no owner or no host', () => {
        expect(parseGitRemote('https://github.com/widget.git')).toBeNull()
        expect(parseGitRemote('/srv/repos/widget.git')).toBeNull()
        expect(parseGitRemote('')).toBeNull()
    })
})

describe('resolveGitHostTarget', () => {
    it('resolves github.com against the public API', () => {
        const result = resolveGitHostTarget('git@github.com:acme/widget.git', { 'github.com': 'tok' })
        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(result.value).toMatchObject({
            kind: 'github', apiBase: 'https://api.github.com', owner: 'acme', repo: 'widget', token: 'tok'
        })
    })

    it('reports a missing github.com token as such', () => {
        expect(resolveGitHostTarget('https://github.com/acme/widget', {}))
            .toEqual({ outcome: 'no-token', host: 'github.com' })
    })

    it('treats a token-configured unknown host as GitHub Enterprise', () => {
        const result = resolveGitHostTarget('https://ghe.corp.example/acme/widget', {
            'ghe.corp.example': 'tok'
        })
        expect(result.outcome).toBe('ok')
        if (result.outcome !== 'ok') return
        expect(result.value.apiBase).toBe('https://ghe.corp.example/api/v3')
    })

    it('refuses an unknown host with no token instead of guessing', () => {
        expect(resolveGitHostTarget('https://ghe.corp.example/acme/widget', {}))
            .toEqual({ outcome: 'unsupported-host', host: 'ghe.corp.example' })
    })

    it('names the forges it does not support yet, even with a token', () => {
        expect(resolveGitHostTarget('git@gitlab.com:acme/widget.git', { 'gitlab.com': 'tok' }))
            .toEqual({ outcome: 'unsupported-host', host: 'gitlab.com' })
        expect(resolveGitHostTarget('git@bitbucket.org:acme/widget.git', { 'bitbucket.org': 'tok' }))
            .toEqual({ outcome: 'unsupported-host', host: 'bitbucket.org' })
    })

    it('rejects an unparseable remote', () => {
        const result = resolveGitHostTarget('not a remote', {})
        expect(result.outcome).toBe('rejected')
    })
})
