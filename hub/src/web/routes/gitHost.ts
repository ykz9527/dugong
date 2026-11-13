import { Hono } from 'hono'
import { z } from 'zod'
import {
    getSettingsFile,
    readSettingsOrThrow,
    updateSettings,
    type Settings
} from '../../config/settings'
import { isGitHostOwner } from '../../gitHost'
import type { WebAppEnv } from '../middleware/auth'

/**
 * Git forge credentials.
 *
 * Owner-only, like hub settings: a token here can push to and open pull
 * requests against every repo it can reach, so it is not a per-namespace
 * setting. Values are never read back — the API returns only which hosts are
 * configured and a last-four hint to tell two tokens apart.
 */

const OWNER_ONLY_ERROR = 'Git host tokens are only available to the hub owner'

const HOSTNAME_RE = /^[a-z0-9.-]+$/

const PutTokenRequestSchema = z.object({
    host: z.string().min(1).max(253),
    token: z.string().min(1).max(500)
})

export function maskToken(token: string): string {
    // Four characters is enough to distinguish two tokens without being enough
    // to narrow a brute force meaningfully.
    return token.length <= 4 ? '••••' : `••••${token.slice(-4)}`
}

function toTokenList(settings: Settings): Array<{ host: string; hint: string }> {
    return Object.entries(settings.gitHostTokens ?? {})
        .map(([host, token]) => ({ host, hint: maskToken(token) }))
        .sort((a, b) => a.host.localeCompare(b.host))
}

export function createGitHostRoutes(dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/git-host/tokens', async (c) => {
        if (!isGitHostOwner(c.get('namespace'))) {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }
        c.header('Cache-Control', 'no-store')
        const settings = await readSettingsOrThrow(getSettingsFile(dataDir))
        return c.json({ tokens: toTokenList(settings) })
    })

    app.put('/git-host/tokens', async (c) => {
        if (!isGitHostOwner(c.get('namespace'))) {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = PutTokenRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const host = parsed.data.host.trim().toLowerCase()
        if (!HOSTNAME_RE.test(host)) {
            return c.json({ error: 'host must be a hostname' }, 400)
        }

        const response = await updateSettings(getSettingsFile(dataDir), (current) => {
            const settings: Settings = {
                ...current,
                gitHostTokens: { ...current.gitHostTokens, [host]: parsed.data.token }
            }
            return { settings, result: { tokens: toTokenList(settings) } }
        })

        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    app.delete('/git-host/tokens/:host', async (c) => {
        if (!isGitHostOwner(c.get('namespace'))) {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }

        const host = (c.req.param('host') ?? '').trim().toLowerCase()
        const settingsFile = getSettingsFile(dataDir)
        const existing = await readSettingsOrThrow(settingsFile)
        if (!existing.gitHostTokens?.[host]) {
            return c.json({ error: 'No token configured for that host' }, 404)
        }

        const response = await updateSettings(settingsFile, (current) => {
            const tokens = { ...current.gitHostTokens }
            delete tokens[host]
            const settings: Settings = { ...current, gitHostTokens: tokens }
            return { settings, result: { tokens: toTokenList(settings) } }
        })

        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}
