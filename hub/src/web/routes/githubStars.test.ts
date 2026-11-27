import { describe, expect, it } from 'bun:test'
import { createGithubStarsRoutes } from './githubStars'

describe('GET /github-stars', () => {
    it('asks GitHub once and serves the cached count', async () => {
        let calls = 0
        const fake = (async () => {
            calls += 1
            return new Response(JSON.stringify({ stargazers_count: 42 }))
        }) as unknown as typeof fetch
        const app = createGithubStarsRoutes(fake)

        const first = await (await app.request('/github-stars')).json()
        const second = await (await app.request('/github-stars')).json()

        expect(first).toEqual({ stars: 42 })
        expect(second).toEqual({ stars: 42 })
        expect(calls).toBe(1)
    })

    it('answers null when GitHub is unreachable', async () => {
        const fake = (async () => { throw new Error('offline') }) as unknown as typeof fetch
        const body = await (await createGithubStarsRoutes(fake).request('/github-stars')).json()
        expect(body).toEqual({ stars: null })
    })
})
