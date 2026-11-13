import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { getActiveWorkspaceUserId, useActiveWorkspaceUserId } from '@/lib/activeWorkspaceUser'

function isPushSupported(): boolean {
    return typeof window !== 'undefined'
        && 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
    const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
    const base64 = (base64Url + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/')
    const raw = atob(base64)
    const output = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i += 1) {
        output[i] = raw.charCodeAt(i)
    }
    return output
}

/**
 * VAPID public key that the currently stored push subscription was created
 * with. When the hub changes (or its keys rotate), existing browser
 * subscriptions become undeliverable (push services reject them with
 * VapidPkHashMismatch), so we compare and re-create them on the next load.
 */
const PUSH_VAPID_KEY_STORAGE = 'hapi.push.vapidKey'

function readStoredVapidKey(): string | null {
    try {
        return localStorage.getItem(PUSH_VAPID_KEY_STORAGE)
    } catch {
        return null
    }
}

function writeStoredVapidKey(publicKey: string): void {
    try {
        localStorage.setItem(PUSH_VAPID_KEY_STORAGE, publicKey)
    } catch {
        // Ignore storage errors — the key check degrades to a re-subscribe.
    }
}

export function usePushNotifications(api: ApiClient | null) {
    const [isSupported, setIsSupported] = useState(false)
    const [permission, setPermission] = useState<NotificationPermission>('default')
    const [isSubscribed, setIsSubscribed] = useState(false)

    const refreshSubscription = useCallback(async () => {
        if (!isPushSupported()) {
            setIsSupported(false)
            setIsSubscribed(false)
            return
        }

        setIsSupported(true)
        setPermission(Notification.permission)

        if (Notification.permission !== 'granted') {
            setIsSubscribed(false)
            return
        }

        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.getSubscription()
        let keyMatches = true
        if (subscription && api) {
            try {
                const { publicKey } = await api.getPushVapidPublicKey()
                keyMatches = readStoredVapidKey() === publicKey
            } catch {
                // Key lookup failed — keep the existing subscription benefit of
                // the doubt rather than showing a false "off" state.
            }
        }
        setIsSubscribed(Boolean(subscription) && keyMatches)
    }, [api])

    useEffect(() => {
        void refreshSubscription()
    }, [refreshSubscription])

    // Who this browser is filtered to is a local choice that can change without
    // touching the push subscription, so the hub has to be told again. The
    // registration is an upsert keyed on the endpoint - re-sending it only
    // moves the workspace user, and it also backfills subscriptions created
    // before the hub had the column at all.
    const activeWorkspaceUserId = useActiveWorkspaceUserId()
    useEffect(() => {
        if (!api || !isSubscribed || !isPushSupported()) {
            return
        }
        let cancelled = false
        void (async () => {
            try {
                const registration = await navigator.serviceWorker.ready
                const subscription = await registration.pushManager.getSubscription()
                const json = subscription?.toJSON()
                const keys = json?.keys
                if (cancelled || !json?.endpoint || !keys?.p256dh || !keys.auth) {
                    return
                }
                await api.subscribePushNotifications({
                    endpoint: json.endpoint,
                    keys: { p256dh: keys.p256dh, auth: keys.auth },
                    workspaceUserId: activeWorkspaceUserId
                })
            } catch (error) {
                // Worst case the hub keeps the previous scope: the operator
                // sees somebody else's notification, which is exactly the
                // pre-existing behaviour, not a new failure mode.
                console.error('[PushNotifications] Failed to re-scope subscription:', error)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [api, isSubscribed, activeWorkspaceUserId])

    const requestPermission = useCallback(async (): Promise<boolean> => {
        if (!isPushSupported()) {
            return false
        }

        const result = await Notification.requestPermission()
        setPermission(result)
        if (result !== 'granted') {
            setIsSubscribed(false)
        }
        return result === 'granted'
    }, [])

    const subscribe = useCallback(async (): Promise<boolean> => {
        if (!api || !isPushSupported()) {
            return false
        }

        if (Notification.permission !== 'granted') {
            setPermission(Notification.permission)
            return false
        }

        try {
            const registration = await navigator.serviceWorker.ready
            const existing = await registration.pushManager.getSubscription()
            const { publicKey } = await api.getPushVapidPublicKey()
            const applicationServerKey = base64UrlToUint8Array(publicKey).buffer as ArrayBuffer
            // A subscription created against a previous hub or VAPID key can
            // never receive notifications from the current hub. Detect the
            // mismatch via the key recorded at subscribe time and recreate it.
            let subscription = existing
            if (existing && readStoredVapidKey() !== publicKey) {
                const staleEndpoint = existing.endpoint
                const unsubscribed = await existing.unsubscribe()
                if (!unsubscribed) return false
                // Prune the obsolete endpoint from the hub so it stops
                // receiving failed sends (VapidPkHashMismatch) for a
                // subscription that can no longer be reached.
                if (staleEndpoint) {
                    try {
                        await api.unsubscribePushNotifications({ endpoint: staleEndpoint })
                    } catch {
                        // Best-effort cleanup — a stale hub registration is
                        // harmless beyond repeated failed sends until pruned.
                    }
                }
                subscription = null
            }
            if (!subscription) {
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey
                })
            }

            const json = subscription.toJSON()
            const keys = json.keys
            if (!json.endpoint || !keys?.p256dh || !keys.auth) {
                return false
            }

            await api.subscribePushNotifications({
                endpoint: json.endpoint,
                keys: {
                    p256dh: keys.p256dh,
                    auth: keys.auth
                },
                workspaceUserId: getActiveWorkspaceUserId()
            })
            // Only record the key after the hub registration succeeded. A
            // failed registration must leave the previous key in place so the
            // next load retries the replacement instead of reusing a
            // subscription the hub never learned about.
            writeStoredVapidKey(publicKey)
            setIsSubscribed(true)
            return true
        } catch (error) {
            console.error('[PushNotifications] Failed to subscribe:', error)
            return false
        }
    }, [api])

    const unsubscribe = useCallback(async (): Promise<boolean> => {
        if (!api || !isPushSupported()) {
            return false
        }

        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (!subscription) {
                setIsSubscribed(false)
                return true
            }

            const endpoint = subscription.endpoint
            const success = await subscription.unsubscribe()
            if (!success) return false
            await api.unsubscribePushNotifications({ endpoint })
            setIsSubscribed(false)
            return true
        } catch (error) {
            console.error('[PushNotifications] Failed to unsubscribe:', error)
            return false
        }
    }, [api])

    return {
        isSupported,
        permission,
        isSubscribed,
        requestPermission,
        subscribe,
        unsubscribe
    }
}
