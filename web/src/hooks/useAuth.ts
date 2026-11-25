import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient, ApiError } from '@/api/client'
import type { AuthResponse } from '@/types/api'

export type AuthSource =
    | { type: 'telegram'; initData: string }
    | { type: 'accessToken'; token: string }

function decodeJwtExpMs(token: string): number | null {
    const parts = token.split('.')
    if (parts.length < 2) return null

    const payloadBase64Url = parts[1] ?? ''
    const payloadBase64 = payloadBase64Url
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payloadBase64Url.length / 4) * 4, '=')

    try {
        const decoded = globalThis.atob(payloadBase64)
        const payload = JSON.parse(decoded) as { exp?: unknown }
        if (typeof payload.exp !== 'number') return null
        return payload.exp * 1000
    } catch {
        return null
    }
}

function getAuthPayload(source: AuthSource): { initData: string } | { accessToken: string } {
    if (source.type === 'telegram') {
        return { initData: source.initData }
    }
    return { accessToken: source.token }
}

function isNotBoundError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401 && error.code === 'not_bound'
}

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'
const SESSION_PREFIX = 'dugong_session::'
// A cached session is only reused with this much life left; the refresh timer
// below renews it a minute before expiry anyway.
const SESSION_REUSE_MIN_TTL_MS = 5 * 60_000

type CachedSession = { source: string; token: string; user: AuthResponse['user'] }

/** Which login a cached session came from, without storing the secret twice. */
function sourceFingerprint(source: AuthSource): string | null {
    if (source.type !== 'accessToken') return null
    let hash = 0x811c9dc5
    for (let i = 0; i < source.token.length; i += 1) {
        hash = Math.imul(hash ^ source.token.charCodeAt(i), 0x01000193)
    }
    return (hash >>> 0).toString(36)
}

/**
 * The JWT from the last `/api/auth`, kept across page loads. Without it every
 * open waits one full round trip for a fresh JWT before it can ask for any
 * data - about half a second on a phone through the relay.
 */
function readCachedSession(baseUrl: string, source: AuthSource): CachedSession | null {
    const fingerprint = sourceFingerprint(source)
    if (!fingerprint) return null
    try {
        const cached = JSON.parse(localStorage.getItem(`${SESSION_PREFIX}${baseUrl}`) ?? 'null') as CachedSession | null
        if (!cached || cached.source !== fingerprint || typeof cached.token !== 'string') return null
        const expMs = decodeJwtExpMs(cached.token)
        if (!expMs || expMs - Date.now() < SESSION_REUSE_MIN_TTL_MS) return null
        return cached
    } catch {
        return null
    }
}

/** Logout: drop the cached JWT along with the access token it came from. */
export function clearCachedSession(baseUrl: string): void {
    try {
        localStorage.removeItem(`${SESSION_PREFIX}${baseUrl}`)
    } catch {
        // Ignore storage errors (private mode, full quota, etc.)
    }
}

function writeCachedSession(baseUrl: string, source: AuthSource, auth: AuthResponse | null): void {
    const fingerprint = sourceFingerprint(source)
    if (!fingerprint) return
    try {
        if (auth) {
            const cached: CachedSession = { source: fingerprint, token: auth.token, user: auth.user }
            localStorage.setItem(`${SESSION_PREFIX}${baseUrl}`, JSON.stringify(cached))
        } else {
            localStorage.removeItem(`${SESSION_PREFIX}${baseUrl}`)
        }
    } catch {
        // Ignore storage errors (private mode, full quota, etc.)
    }
}

function rememberAccessToken(baseUrl: string, accessToken: string): void {
    try {
        localStorage.setItem(`${ACCESS_TOKEN_PREFIX}${baseUrl}`, accessToken)
    } catch {
        // Ignore storage errors (private mode, full quota, etc.)
    }
}

export function useAuth(authSource: AuthSource | null, baseUrl: string): {
    token: string | null
    user: AuthResponse['user'] | null
    api: ApiClient | null
    isLoading: boolean
    error: string | null
    needsBinding: boolean
    bind: (accessToken: string) => Promise<void>
} {
    const [token, setToken] = useState<string | null>(null)
    const [user, setUser] = useState<AuthResponse['user'] | null>(null)
    const [isLoading, setIsLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [needsBinding, setNeedsBinding] = useState<boolean>(false)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
    const tokenRef = useRef<string | null>(null)
    const lastRefreshAttemptRef = useRef<number>(0)

    // Stable reference for auth source to use in effects
    const authSourceRef = useRef(authSource)
    authSourceRef.current = authSource
    tokenRef.current = token

    const refreshAuth = useCallback(async (options?: {
        minTtlMs?: number
        hardFail?: boolean
        force?: boolean
    }): Promise<string | null> => {
        const currentSource = authSourceRef.current
        const currentToken = tokenRef.current
        if (!currentSource) {
            return null
        }

        const expMs = currentToken ? decodeJwtExpMs(currentToken) : null
        const minTtlMs = options?.minTtlMs ?? 0
        const now = Date.now()
        const ttlMs = expMs ? expMs - now : null
        const needsRefreshForTtl = ttlMs !== null && ttlMs <= minTtlMs
        if (!options?.force && ttlMs !== null && ttlMs > minTtlMs) {
            return currentToken
        }
        if (!options?.force && !needsRefreshForTtl && now - lastRefreshAttemptRef.current < 15_000) {
            return currentToken
        }
        if (refreshPromiseRef.current) {
            return await refreshPromiseRef.current
        }

        const run = async () => {
            lastRefreshAttemptRef.current = now

            try {
                const client = new ApiClient('', { baseUrl })
                const auth = await client.authenticate(getAuthPayload(currentSource))
                writeCachedSession(baseUrl, currentSource, auth)
                tokenRef.current = auth.token
                setToken(auth.token)
                setUser(auth.user)
                setError(null)
                setNeedsBinding(false)
                return auth.token
            } catch (error) {
                if (currentSource.type === 'telegram' && isNotBoundError(error)) {
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    setError(null)
                    setNeedsBinding(true)
                    return null
                }
                const isExpired = expMs ? Date.now() >= expMs : false
                if (options?.hardFail || isExpired) {
                    writeCachedSession(baseUrl, currentSource, null)
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    const msg = currentSource.type === 'telegram'
                        ? 'Session expired. Reopen the Mini App from Telegram.'
                        : 'Session expired. Please login again.'
                    setError(msg)
                }
                return null
            }
        }

        const refreshPromise = run()
        refreshPromiseRef.current = refreshPromise

        try {
            return await refreshPromise
        } finally {
            if (refreshPromiseRef.current === refreshPromise) {
                refreshPromiseRef.current = null
            }
        }
    }, [baseUrl])

    const bind = useCallback(async (accessToken: string) => {
        const currentSource = authSourceRef.current
        if (!currentSource || currentSource.type !== 'telegram') {
            setError('Binding is only supported in Telegram.')
            return
        }

        setIsLoading(true)
        setError(null)
        try {
            const client = new ApiClient('', { baseUrl })
            const auth = await client.bind({ initData: currentSource.initData, accessToken })
            tokenRef.current = auth.token
            setToken(auth.token)
            setUser(auth.user)
            setNeedsBinding(false)
            // Persist the CLI access token so Settings → Companion pairing QR
            // can encode the same long-lived token in the deeplink. The PWA
            // already does this for browser/CLI logins via useAuthSource.
            rememberAccessToken(baseUrl, accessToken)
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Binding failed')
            throw error
        } finally {
            setIsLoading(false)
        }
    }, [baseUrl])

    // Keep the ApiClient referentially stable across token *refreshes*: the client always reads
    // the live token via getToken (tokenRef), so it never needs rebuilding when the token value
    // changes — only when auth presence toggles (login/logout). Rebuilding on every refresh churns
    // `api`'s identity, which remounts everything keyed on it (VoiceBackendSession `[props.api]`,
    // GeneratedImageCard `[ctx.api, ...]`) and drives the remount/refetch storm. Issue #927.
    const hasToken = token !== null
    const api = useMemo(() => (
        hasToken
            ? new ApiClient(tokenRef.current ?? '', {
                baseUrl,
                getToken: () => tokenRef.current,
                onUnauthorized: () => refreshAuth({ force: true })
            })
            : null
    ), [baseUrl, refreshAuth, hasToken])

    // Declared before the auth effect: on a base URL change this reset must
    // run first, or it would wipe the cached session the auth effect restores.
    useEffect(() => {
        tokenRef.current = null
        refreshPromiseRef.current = null
        lastRefreshAttemptRef.current = 0
        setToken(null)
        setUser(null)
        setError(null)
        setNeedsBinding(false)
    }, [baseUrl])

    useEffect(() => {
        let isCancelled = false

        async function run() {
            if (!authSource) {
                // No auth source - waiting for login
                setNeedsBinding(false)
                return
            }

            const cached = readCachedSession(baseUrl, authSource)
            if (cached) {
                // A hub that no longer accepts it answers 401, and the
                // client's onUnauthorized fetches a fresh one.
                tokenRef.current = cached.token
                setToken(cached.token)
                setUser(cached.user)
                setError(null)
                setNeedsBinding(false)
                return
            }

            setIsLoading(true)
            setError(null)
            setNeedsBinding(false)
            try {
                const client = new ApiClient('', { baseUrl }) // temporary for auth call
                const auth = await client.authenticate(getAuthPayload(authSource))
                if (isCancelled) return
                writeCachedSession(baseUrl, authSource, auth)
                setToken(auth.token)
                setUser(auth.user)
                setNeedsBinding(false)
            } catch (e) {
                if (isCancelled) return
                if (authSource.type === 'telegram' && isNotBoundError(e)) {
                    setToken(null)
                    setUser(null)
                    setError(null)
                    setNeedsBinding(true)
                    return
                }
                setNeedsBinding(false)
                setError(e instanceof Error ? e.message : 'Auth failed')
            } finally {
                if (!isCancelled) {
                    setIsLoading(false)
                }
            }
        }

        run()

        return () => {
            isCancelled = true
        }
    }, [authSource, baseUrl])

    useEffect(() => {
        if (!token || !authSource) {
            return
        }

        const expMs = decodeJwtExpMs(token)
        if (!expMs) {
            return
        }

        let isCancelled = false
        let timeout: ReturnType<typeof setTimeout> | null = null

        const schedule = (delayMs: number) => {
            if (timeout) {
                clearTimeout(timeout)
            }
            timeout = setTimeout(() => void refresh(), Math.max(0, delayMs))
        }

        const refresh = async () => {
            if (isCancelled) return
            const refreshed = await refreshAuth({ force: true })
            if (isCancelled) return
            if (!refreshed && Date.now() < expMs) {
                schedule(15_000)
            }
        }

        schedule(expMs - 60_000 - Date.now())

        return () => {
            isCancelled = true
            if (timeout) {
                clearTimeout(timeout)
            }
        }
    }, [authSource, refreshAuth, token])

    useEffect(() => {
        if (!authSource) {
            return
        }

        const handleActive = () => {
            void refreshAuth({ minTtlMs: 60_000 })
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                handleActive()
            }
        }

        window.addEventListener('focus', handleActive)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('focus', handleActive)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [authSource, refreshAuth])

    return { token, user, api, isLoading, error, needsBinding, bind }
}
