import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { Store } from '../../store'
import { createPushRoutes } from './push'

const JWT_SECRET = new TextEncoder().encode('test-secret')

async function authHeaders() {
    const token = await new SignJWT({ uid: 1, ns: 'default' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function createApp(store: Store) {
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createPushRoutes(store, 'test-vapid-public-key'))
    return app
}

describe('push subscribe route', () => {
    it('records which workspace user the browser is filtered to', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders()

        const subscribe = async (body: Record<string, unknown>) => await app.request('/api/push/subscribe', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                endpoint: 'https://push.example/1',
                keys: { p256dh: 'key', auth: 'auth' },
                ...body
            })
        })

        expect((await subscribe({ workspaceUserId: 'kzz' })).status).toBe(200)
        expect(store.push.getPushSubscriptionsByNamespace('default')[0].workspaceUserId).toBe('kzz')

        // The endpoint is stable across a user switch, so the re-registration
        // has to move the existing row rather than add a second one.
        expect((await subscribe({ workspaceUserId: 'zhou' })).status).toBe(200)
        const subscriptions = store.push.getPushSubscriptionsByNamespace('default')
        expect(subscriptions).toHaveLength(1)
        expect(subscriptions[0].workspaceUserId).toBe('zhou')

        // Older web build, or nobody selected: unfiltered, as before.
        expect((await subscribe({})).status).toBe(200)
        expect(store.push.getPushSubscriptionsByNamespace('default')[0].workspaceUserId).toBeNull()
    })
})
