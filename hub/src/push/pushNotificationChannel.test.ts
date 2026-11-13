import { describe, expect, it } from 'bun:test'
import type { Session, SyncEvent } from '../sync/syncEngine'
import { targetMatcher, type NotificationTargetScope } from '../notifications/notificationScope'
import { SSEManager } from '../sse/sseManager'
import type { StoredWorkspaceUser } from '../store/types'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { PushNotificationChannel } from './pushNotificationChannel'
import type { PushPayload } from './pushService'

const acceptAll = () => () => true

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-task-toast',
        namespace: 'default',
        name: 'Demo task',
        active: true,
        metadata: { flavor: 'codex' },
        ...overrides
    } as Session
}

describe('PushNotificationChannel', () => {
    it('sends task notifications to visible web clients before falling back to push', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const toasts: unknown[] = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                },
                matcherFor: acceptAll
            } as never,
            {
                sendToast: async (_namespace: string, event: unknown) => {
                    toasts.push(event)
                    return 1
                }
            } as never,
            {
                hasVisibleConnection: () => true
            } as never,
            ''
        )

        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'Background work finished'
        })

        expect(toasts).toHaveLength(1)
        expect(pushed).toHaveLength(0)
    })

    it('carries the session directories so a scoped client can drop a colleague\'s toast', async () => {
        const toasts: Array<{ data: { paths?: string[] } }> = []
        const channel = new PushNotificationChannel(
            { sendToNamespace: async () => {}, matcherFor: acceptAll } as never,
            {
                sendToast: async (_namespace: string, event: unknown) => {
                    toasts.push(event as { data: { paths?: string[] } })
                    return 1
                }
            } as never,
            { hasVisibleConnection: () => true } as never,
            ''
        )

        await channel.sendReady(createSession({
            metadata: {
                flavor: 'codex',
                path: '/home/alice/repo-worktrees/0903',
                worktree: { basePath: '/home/alice/repo', branch: 'x', name: 'x' }
            }
        } as Partial<Session>))

        expect(toasts[0]?.data.paths).toEqual([
            '/home/alice/repo-worktrees/0903',
            '/home/alice/repo'
        ])
    })

    it('does not reuse one replacement tag for all task notifications in a session', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never,
            ''
        )

        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'First task'
        })
        await channel.sendTaskNotification(createSession(), {
            status: 'failed',
            summary: 'Second task'
        })

        expect(pushed).toHaveLength(2)
        expect(pushed[0].payload.tag).toBeUndefined()
        expect(pushed[1].payload.tag).toBeUndefined()
    })

    it('skips web-push when native FCM delivered in the same dispatch', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never,
            ''
        )

        const ctx = { nativeGate: { sent: true } }

        await channel.sendPermissionRequest(createSession({
            agentState: {
                requests: { 'req-1': { tool: 'Bash', arguments: {} } }
            }
        }), ctx)
        await channel.sendReady(createSession(), ctx)
        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'Done'
        }, ctx)

        expect(pushed).toHaveLength(0)
    })

    it('falls back to web-push when native gate is unset (FCM failed or absent)', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never,
            ''
        )

        await channel.sendReady(createSession(), { nativeGate: { sent: false } })

        expect(pushed).toHaveLength(1)
    })

    it('still sends web-push when no native gate is provided', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never,
            ''
        )

        await channel.sendReady(createSession())

        expect(pushed).toHaveLength(1)
    })

    it('also skips SSE in-page toast when native gate reports delivery', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const toasts: unknown[] = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async (_namespace: string, event: unknown) => {
                    toasts.push(event)
                    return 99
                }
            } as never,
            {
                hasVisibleConnection: () => true
            } as never,
            ''
        )

        const ctx = { nativeGate: { sent: true } }

        await channel.sendReady(createSession(), ctx)
        await channel.sendPermissionRequest(createSession({
            agentState: { requests: { 'r-1': { tool: 'Bash', arguments: {} } } }
        }), ctx)
        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'Done'
        }, ctx)

        // Even when the PWA is foreground/visible, the operator asked to mute
        // it - the in-page React toast and the OS web-push are both dropped
        // when an FCM companion is on the wrist.
        expect(toasts).toHaveLength(0)
        expect(pushed).toHaveLength(0)
    })

    it('does not let one person\'s open tab swallow another person\'s push', async () => {
        const users: StoredWorkspaceUser[] = [
            { id: 'alice', namespace: 'default', name: 'alice', paths: ['/home/alice'], createdAt: 0, updatedAt: 0 },
            { id: 'bob', namespace: 'default', name: 'bob', paths: ['/home/bob'], createdAt: 0, updatedAt: 0 }
        ]
        const visibility = new VisibilityTracker()
        const sse = new SSEManager(0, visibility)
        const aliceToasts: SyncEvent[] = []
        sse.subscribe({
            id: 'alice-tab',
            namespace: 'default',
            all: true,
            workspaceUserId: 'alice',
            visibility: 'visible',
            send: (event) => { aliceToasts.push(event) },
            sendHeartbeat: () => {}
        })
        const pushed: Array<{ payload: PushPayload; scope?: NotificationTargetScope }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (_namespace: string, payload: PushPayload, scope?: NotificationTargetScope) => {
                    pushed.push({ payload, scope })
                },
                matcherFor: (_namespace: string, scope: NotificationTargetScope) => targetMatcher(users, scope)
            } as never,
            sse,
            visibility,
            ''
        )

        await channel.sendReady(createSession({
            metadata: { flavor: 'codex', path: '/home/bob/repo' }
        } as Partial<Session>))

        expect(aliceToasts).toHaveLength(0)
        expect(pushed).toHaveLength(1)
        expect(pushed[0]?.scope).toEqual(['/home/bob/repo'])

        await channel.sendReady(createSession({
            metadata: { flavor: 'codex', path: '/home/alice/repo' }
        } as Partial<Session>))

        expect(aliceToasts).toHaveLength(1)
        expect(pushed).toHaveLength(1)
    })
})
