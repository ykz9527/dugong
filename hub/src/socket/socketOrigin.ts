/**
 * Whether a Socket.IO request may proceed, judged by its Origin header.
 *
 * The web app is served by the hub itself, under whatever name the user
 * reached it by (localhost, a LAN address, the relay URL). Its own requests
 * are always allowed: the Origin's host matches the Host the request was sent
 * to (or the X-Forwarded-Host a tunnel proxy set). A browser cannot forge
 * either header. Other origins must be listed in corsOrigins. Requests without
 * an Origin (same-origin GETs, the CLI) pass; the socket still needs a token.
 */
export function isAllowedSocketOrigin(
    origin: string | null,
    headers: Pick<Headers, 'get'>,
    corsOrigins: string[]
): boolean {
    if (!origin || corsOrigins.includes('*') || corsOrigins.includes(origin)) {
        return true
    }
    let originHost: string
    try {
        originHost = new URL(origin).host
    } catch {
        return false
    }
    return [headers.get('host'), headers.get('x-forwarded-host')]
        .some((host) => host !== null && host.split(',')[0].trim().toLowerCase() === originHost)
}
