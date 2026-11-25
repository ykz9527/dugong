export type AppGlobalSseSubscription = {
    all: true
    /** The app-wide stream renders no transcript; the open session has its
     *  own stream. See `omitMessageBodies` in the hub's SSE manager. */
    omitMessageBodies: true
}

export type AppSessionSseSubscription = {
    sessionId: string
}

export function getAppGlobalSseSubscription(): AppGlobalSseSubscription {
    return { all: true, omitMessageBodies: true }
}

export function getAppSessionSseSubscription(
    selectedSessionId: string | null | undefined
): AppSessionSseSubscription | null {
    if (!selectedSessionId) {
        return null
    }
    return { sessionId: selectedSessionId }
}
