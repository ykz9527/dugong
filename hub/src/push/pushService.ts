import * as webPush from 'web-push'
import type { Store } from '../store'
import type { VapidKeys } from '../config/vapidKeys'
import { selectTargetsInScope, targetMatcher, type NotificationTargetScope } from '../notifications/notificationScope'

export type PushPayload = {
    title: string
    body: string
    tag?: string
    data?: {
        type: string
        sessionId: string
        url: string
        /** First pending permission request id (permission-request pushes only). */
        requestId?: string
    }
}

type StoredSubscription = {
    endpoint: string
    p256dh: string
    auth: string
}

type PushSubscription = {
    endpoint: string
    keys: {
        p256dh: string
        auth: string
    }
}

export class PushService {
    constructor(
        private readonly vapidKeys: VapidKeys,
        private readonly subject: string,
        private readonly store: Store
    ) {
        webPush.setVapidDetails(this.subject, this.vapidKeys.publicKey, this.vapidKeys.privateKey)
    }

    /**
     * `scope` says who the notification is about; a browser filtered to a
     * workspace user outside it is skipped. Omitted means no scoping — what a
     * caller with no session in hand gets.
     */
    async sendToNamespace(
        namespace: string,
        payload: PushPayload,
        scope?: NotificationTargetScope
    ): Promise<void> {
        const subscriptions = selectTargetsInScope(
            this.store.push.getPushSubscriptionsByNamespace(namespace),
            this.store.workspaceUsers.list(namespace),
            scope
        )
        if (subscriptions.length === 0) {
            return
        }

        const body = JSON.stringify(payload)
        await Promise.all(subscriptions.map((subscription) => {
            return this.sendToSubscription(namespace, subscription, body)
        }))
    }

    /**
     * The same ownership rule as `sendToNamespace`, for targets that are not
     * stored push subscriptions (open browser tabs receiving toasts).
     */
    matcherFor(
        namespace: string,
        scope: NotificationTargetScope
    ): (workspaceUserId: string | null | undefined) => boolean {
        return targetMatcher(this.store.workspaceUsers.list(namespace), scope)
    }

    private async sendToSubscription(
        namespace: string,
        subscription: StoredSubscription,
        body: string
    ): Promise<void> {
        const pushSubscription: PushSubscription = {
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
            }
        }

        try {
            await webPush.sendNotification(pushSubscription, body)
        } catch (error) {
            const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
                ? (error as { statusCode: number }).statusCode
                : null

            if (statusCode === 410) {
                this.store.push.removePushSubscription(namespace, subscription.endpoint)
                return
            }

            console.error('[PushService] Failed to send notification:', error)
        }
    }
}
