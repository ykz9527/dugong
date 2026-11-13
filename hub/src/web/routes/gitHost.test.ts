import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebAppEnv } from '../middleware/auth'
import { createGitHostRoutes, maskToken } from './gitHost'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function makeApp(namespace = 'default'): { app: Hono<WebAppEnv>; dataDir: string } {
    const dataDir = mkdtempSync(join(tmpdir(), 'hapi-git-host-'))
    tempDirs.push(dataDir)

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        c.set('userId', 1)
        await next()
    })
    app.route('/api', createGitHostRoutes(dataDir))
    return { app, dataDir }
}

function put(app: Hono<WebAppEnv>, body: unknown): Promise<Response> {
    return app.request('/api/git-host/tokens', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }) as Promise<Response>
}

describe('maskToken', () => {
    it('keeps only the last four characters', () => {
        expect(maskToken('ghp_abcdefgh1234')).toBe('••••1234')
        expect(maskToken('abc')).toBe('••••')
    })
})

describe('git host token routes', () => {
    it('starts empty and records a token', async () => {
        const { app } = makeApp()

        expect(await (await app.request('/api/git-host/tokens')).json()).toEqual({ tokens: [] })

        const response = await put(app, { host: 'github.com', token: 'ghp_secret1234' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            tokens: [{ host: 'github.com', hint: '••••1234' }]
        })
    })

    it('never returns the token value itself', async () => {
        const { app } = makeApp()
        await put(app, { host: 'github.com', token: 'ghp_secret1234' })

        const body = await (await app.request('/api/git-host/tokens')).text()
        expect(body).not.toContain('ghp_secret1234')
    })

    it('normalises the host and replaces an existing entry', async () => {
        const { app } = makeApp()
        await put(app, { host: 'GitHub.com', token: 'first1111' })
        await put(app, { host: 'github.com', token: 'second2222' })

        expect(await (await app.request('/api/git-host/tokens')).json()).toEqual({
            tokens: [{ host: 'github.com', hint: '••••2222' }]
        })
    })

    it('rejects a malformed host or body', async () => {
        const { app } = makeApp()
        expect((await put(app, { host: 'not a host', token: 'x' })).status).toBe(400)
        expect((await put(app, { host: 'github.com' })).status).toBe(400)
        expect((await put(app, { host: '', token: 'x' })).status).toBe(400)
    })

    it('deletes a token and 404s an unknown host', async () => {
        const { app } = makeApp()
        await put(app, { host: 'github.com', token: 'ghp_secret1234' })

        const deleted = await app.request('/api/git-host/tokens/github.com', { method: 'DELETE' })
        expect(deleted.status).toBe(200)
        expect(await deleted.json()).toEqual({ tokens: [] })

        expect((await app.request('/api/git-host/tokens/github.com', { method: 'DELETE' })).status).toBe(404)
    })

    it('is owner-only', async () => {
        const { app } = makeApp('tenant')
        expect((await app.request('/api/git-host/tokens')).status).toBe(403)
        expect((await put(app, { host: 'github.com', token: 'x' })).status).toBe(403)
        expect((await app.request('/api/git-host/tokens/github.com', { method: 'DELETE' })).status).toBe(403)
    })
})
