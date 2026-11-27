import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'

const REPO_API = 'https://api.github.com/repos/ykz9527/dugong'
const HIT_TTL_MS = 60 * 60 * 1000
const MISS_TTL_MS = 10 * 60 * 1000

/**
 * Star count for the sidebar's star button. The hub asks GitHub rather than
 * the browser: many browsers can't reach api.github.com, and one cached call
 * per hub keeps clear of GitHub's 60-per-hour anonymous limit. `null` when
 * GitHub can't be reached; the button then shows no count.
 */
export function createGithubStarsRoutes(fetchImpl: typeof fetch = fetch): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    let cached: { stars: number | null; expiresAt: number } | null = null
    let inflight: Promise<number | null> | null = null

    const load = async (): Promise<number | null> => {
        try {
            const res = await fetchImpl(REPO_API, {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dugong-hub' },
                signal: AbortSignal.timeout(5000),
            })
            if (!res.ok) return null
            const body = await res.json() as { stargazers_count?: unknown }
            return typeof body.stargazers_count === 'number' ? body.stargazers_count : null
        } catch {
            return null
        }
    }

    app.get('/github-stars', async (c) => {
        if (!cached || cached.expiresAt <= Date.now()) {
            inflight ??= load().finally(() => { inflight = null })
            const stars = await inflight
            cached = { stars, expiresAt: Date.now() + (stars === null ? MISS_TTL_MS : HIT_TTL_MS) }
        }
        return c.json({ stars: cached.stars })
    })

    return app
}
