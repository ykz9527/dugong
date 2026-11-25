import { beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createWebApp } from './server'
import type { EmbeddedWebAsset } from './embeddedAssets'
import { Store } from '../store'
import { createConfiguration } from '../configuration'

const dir = mkdtempSync(join(tmpdir(), 'dugong-embedded-'))
const script = 'console.log("hello");'.repeat(200)
writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>')
writeFileSync(join(dir, 'app.js'), script)
writeFileSync(join(dir, 'icon.png'), new Uint8Array([137, 80, 78, 71]))

function makeApp() {
    const assets: EmbeddedWebAsset[] = [
        { path: '/index.html', sourcePath: join(dir, 'index.html'), mimeType: 'text/html; charset=utf-8' },
        { path: '/assets/app-abc123.js', sourcePath: join(dir, 'app.js'), mimeType: 'text/javascript; charset=utf-8' },
        { path: '/assets/icon-abc123.png', sourcePath: join(dir, 'icon.png'), mimeType: 'image/png' }
    ]
    return createWebApp({
        getSyncEngine: () => null,
        getTaskOrchestrator: () => null,
        getTaskReview: () => null,
        getTaskWorktree: () => null,
        getSseManager: () => null,
        getVisibilityTracker: () => null,
        jwtSecret: new TextEncoder().encode('test-secret-value-long-enough-ok'),
        store: new Store(':memory:'),
        vapidPublicKey: '',
        embeddedAssetMap: new Map(assets.map((asset) => [asset.path, asset]))
    })
}

beforeAll(async () => {
    await createConfiguration()
})

describe('embedded web asset serving', () => {
    it('gzips a hashed script and lets browsers keep it', async () => {
        const response = await makeApp().request('/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'gzip, br' } })

        expect(response.headers.get('Content-Encoding')).toBe('gzip')
        expect(response.headers.get('Cache-Control')).toContain('immutable')
        expect(response.headers.get('Vary')).toBe('Accept-Encoding')
        const body = new Uint8Array(await response.arrayBuffer())
        expect(body.length).toBeLessThan(script.length / 4)
        expect(gunzipSync(body).toString()).toBe(script)
    })

    it('serves the plain file to a client that refuses gzip', async () => {
        const response = await makeApp().request('/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'gzip;q=0' } })

        expect(response.headers.get('Content-Encoding')).toBeNull()
        expect(await response.text()).toBe(script)
    })

    it('does not gzip images, and makes index.html revalidate', async () => {
        const app = makeApp()
        const image = await app.request('/assets/icon-abc123.png', { headers: { 'Accept-Encoding': 'gzip' } })
        const index = await app.request('/some/route', { headers: { 'Accept-Encoding': 'gzip' } })

        expect(image.headers.get('Content-Encoding')).toBeNull()
        expect(index.headers.get('Cache-Control')).toBe('no-cache')
        expect(gunzipSync(new Uint8Array(await index.arrayBuffer())).toString()).toContain('<div id="root">')
    })

    it('answers 404 for a hashed file this build does not have', async () => {
        const response = await makeApp().request('/assets/SessionChat-old123.js')

        expect(response.status).toBe(404)
        expect(response.headers.get('Cache-Control')).toBe('no-store')
    })
})
