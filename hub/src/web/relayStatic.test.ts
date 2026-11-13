import { beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createWebApp } from './server'
import { Store } from '../store'
import { createConfiguration } from '../configuration'

/**
 * Relay mode must still serve this fork's own frontend.
 *
 * Upstream stops before static serving when a relay is up and returns a notice
 * pointing at the official web app, to keep several MB off the tunnel. That is
 * wrong here: the board only exists in *our* frontend, so a phone sent to the
 * official app silently loses the feature this fork is for. This pins the
 * inversion — the notice is now only for having no frontend at all.
 */
const builtIndexHtml = join(import.meta.dir, '../../../web/dist/index.html')
const hasBuiltWeb = existsSync(builtIndexHtml)

function makeApp() {
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
        embeddedAssetMap: null,
        relayMode: true
    })
}

beforeAll(async () => {
    await createConfiguration()
})

describe('relay mode static serving', () => {
    it.skipIf(!hasBuiltWeb)('serves the built frontend on a relay, not the official-app notice', async () => {
        const response = await makeApp().request('/')
        const body = await response.text()

        expect(response.status).toBe(200)
        expect(body).not.toContain('app.hapi.run')
        // The real index.html, not a hand-written notice page.
        expect(body).toContain('<div id="root">')
    })
})
