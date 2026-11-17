import { createConfiguration, type ConfigSource } from './configuration'
import { Store } from './store'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { TaskOrchestrator, toTaskUpdatedEvent } from './sync/taskOrchestrator'
import { TaskScheduler } from './sync/taskScheduler'
import { AssistantService, ASSISTANT_DEFAULT_MODEL } from './sync/assistantService'
import { AssistantCompaction, readCompactThreshold } from './sync/assistantCompaction'
import { NativeNotificationComposer } from './notifications/nativeNotificationComposer'
import { TaskReviewService } from './sync/taskReview'
import { TaskWorktreeService } from './sync/taskWorktree'
import { getSettingsFile, readSettingsOrThrow } from './config/settings'
import type { CodexCollaborationMode, CopilotAgentMode, PermissionMode } from '@hapi/protocol'
import { NotificationHub } from './notifications/notificationHub'
import type { NotificationChannel } from './notifications/notificationTypes'
import { HappyBot } from './telegram/bot'
import { startWebServer } from './web/server'
import { getOrCreateJwtSecret } from './config/jwtSecret'
import { getOrCreateOwnerId } from './config/ownerId'
import { createSocketServer } from './socket/server'
import { SSEManager } from './sse/sseManager'
import { getOrCreateVapidKeys } from './config/vapidKeys'
import { PushService } from './push/pushService'
import { PushNotificationChannel } from './push/pushNotificationChannel'
import { FcmService } from './fcm/fcmService'
import { FcmNotificationChannel } from './fcm/fcmNotificationChannel'
import { resolveFcmConfig } from './fcm/fcmConfig'
import { ApnsClient } from './push-ios/apnsClient'
import { RelayClient } from './push-ios/relayClient'
import { IosPushService } from './push-ios/iosPushService'
import { IosPushNotificationChannel } from './push-ios/iosPushChannel'
import { resolveIosPushConfig } from './push-ios/iosPushConfig'
import { VisibilityTracker } from './visibility/visibilityTracker'
import { TunnelManager } from './tunnel'
import { refreshRejectedRelayAuthKey, resolveRelayAuthKey } from './tunnel/relayAuth'
import { waitForTunnelTlsReady } from './tunnel/tlsGate'
import { ServerChanChannel } from './serverchan/channel'
import QRCode from 'qrcode'
import type { Server as BunServer } from 'bun'
import type { WebSocketData } from '@socket.io/bun-engine'

/** Format config source for logging */
function formatSource(source: ConfigSource | 'generated'): string {
    switch (source) {
        case 'env':
            return 'environment'
        case 'file':
            return 'settings.json'
        case 'default':
            return 'default'
        case 'generated':
            return 'generated'
    }
}

type RelayFlagSource = 'default' | '--relay' | '--no-relay'

function resolveRelayFlag(args: string[]): { enabled: boolean; source: RelayFlagSource } {
    let enabled = false
    let source: RelayFlagSource = 'default'

    for (const arg of args) {
        if (arg === '--relay') {
            enabled = true
            source = '--relay'
        } else if (arg === '--no-relay') {
            enabled = false
            source = '--no-relay'
        }
    }

    return { enabled, source }
}

function normalizeOrigin(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) {
        return ''
    }
    try {
        return new URL(trimmed).origin
    } catch {
        return trimmed
    }
}

function normalizeOrigins(origins: string[]): string[] {
    const normalized = origins
        .map(normalizeOrigin)
        .filter(Boolean)
    if (normalized.includes('*')) {
        return ['*']
    }
    return Array.from(new Set(normalized))
}

function mergeCorsOrigins(base: string[], extra: string[]): string[] {
    if (base.includes('*') || extra.includes('*')) {
        return ['*']
    }
    const merged = new Set<string>()
    for (const origin of base) {
        merged.add(origin)
    }
    for (const origin of extra) {
        merged.add(origin)
    }
    return Array.from(merged)
}

export interface HubInstance {
    stop(): Promise<void>
}

export interface StartHubOptions {
    args?: string[]
}

export async function startHub(options: StartHubOptions = {}): Promise<HubInstance> {
    console.log('dugong hub starting...')

    let syncEngine: SyncEngine | null = null
    let taskOrchestrator: TaskOrchestrator | null = null
    let assistantService: AssistantService | null = null
    let taskReview: TaskReviewService | null = null
    let taskWorktree: TaskWorktreeService | null = null
    let taskScheduler: TaskScheduler | null = null
    let happyBot: HappyBot | null = null
    let webServer: BunServer<WebSocketData> | null = null
    let sseManager: SSEManager | null = null
    let visibilityTracker: VisibilityTracker | null = null
    let notificationHub: NotificationHub | null = null
    let tunnelManager: TunnelManager | null = null

    // Load configuration (async - loads from env/file with persistence)
    const relayApiDomain = process.env.DUGONG_RELAY_API || 'relay.hapi.run'
    const relayFlag = resolveRelayFlag(options.args ?? process.argv)
    const officialWebUrl = process.env.DUGONG_OFFICIAL_WEB_URL || 'https://app.hapi.run'
    const config = await createConfiguration()
    const baseCorsOrigins = normalizeOrigins(config.corsOrigins)
    const relayCorsOrigin = normalizeOrigin(officialWebUrl)
    const corsOrigins = relayFlag.enabled
        ? mergeCorsOrigins(baseCorsOrigins, relayCorsOrigin ? [relayCorsOrigin] : [])
        : baseCorsOrigins

    // Display CLI API token information
    if (config.cliApiTokenIsNew) {
        console.log('')
        console.log('='.repeat(70))
        console.log('  NEW CLI_API_TOKEN GENERATED')
        console.log('='.repeat(70))
        console.log('')
        console.log(`  Token: ${config.cliApiToken}`)
        console.log('')
        console.log(`  Saved to: ${config.settingsFile}`)
        console.log('')
        console.log('='.repeat(70))
        console.log('')
    } else {
        console.log(`[Hub] CLI_API_TOKEN: loaded from ${formatSource(config.sources.cliApiToken)}`)
    }

    // Display other configuration sources
    console.log(`[Hub] DUGONG_LISTEN_HOST: ${config.listenHost} (${formatSource(config.sources.listenHost)})`)
    console.log(`[Hub] DUGONG_LISTEN_PORT: ${config.listenPort} (${formatSource(config.sources.listenPort)})`)
    console.log(`[Hub] DUGONG_PUBLIC_URL: ${config.publicUrl} (${formatSource(config.sources.publicUrl)})`)

    if (!config.telegramEnabled) {
        console.log('[Hub] Telegram: disabled (no TELEGRAM_BOT_TOKEN)')
    } else {
        const tokenSource = formatSource(config.sources.telegramBotToken)
        console.log(`[Hub] Telegram: enabled (${tokenSource})`)
        const notificationSource = formatSource(config.sources.telegramNotification)
        console.log(`[Hub] Telegram notifications: ${config.telegramNotification ? 'enabled' : 'disabled'} (${notificationSource})`)
    }
    if (config.serverChanSendKey) {
        const source = formatSource(config.sources.serverChanSendKey)
        const notificationSource = formatSource(config.sources.serverChanNotification)
        const backgroundOnlySource = formatSource(config.sources.serverChanBackgroundOnly)
        console.log(`[Hub] ServerChan: enabled (${source})`)
        console.log(`[Hub] ServerChan notifications: ${config.serverChanNotification ? 'enabled' : 'disabled'} (${notificationSource})`)
        console.log(`[Hub] ServerChan background-only: ${config.serverChanBackgroundOnly ? 'enabled' : 'disabled'} (${backgroundOnlySource})`)
    } else {
        console.log('[Hub] ServerChan: disabled (no SERVERCHAN_SENDKEY)')
    }

    // Display tunnel status
    if (relayFlag.enabled) {
        console.log(`[Hub] Tunnel: enabled (${relayFlag.source}), API: ${relayApiDomain}`)
    } else {
        console.log(`[Hub] Tunnel: disabled (${relayFlag.source})`)
    }

    const store = new Store(config.dbPath)
    const jwtSecret = await getOrCreateJwtSecret()
    const vapidKeys = await getOrCreateVapidKeys(config.dataDir)
    const vapidSubject = process.env.VAPID_SUBJECT ?? 'https://github.com/ykz9527/dugong'
    const pushService = new PushService(vapidKeys, vapidSubject, store)

    visibilityTracker = new VisibilityTracker()
    sseManager = new SSEManager(30_000, visibilityTracker)

    const socketServer = createSocketServer({
        store,
        jwtSecret,
        corsOrigins,
        getSession: (sessionId) => {
            if (syncEngine) {
                return syncEngine.getSession(sessionId) ?? null
            }
            return store.sessions.getSession(sessionId)
        },
        onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event),
        onSessionAlive: (payload) => syncEngine?.handleSessionAlive(payload),
        onSessionReady: (payload) => syncEngine?.handleSessionReady(payload),
        onSessionEnd: (payload) => syncEngine?.handleSessionEnd(payload),
        onMachineAlive: (payload) => syncEngine?.handleMachineAlive(payload),
        onBackgroundTaskDelta: (sessionId, delta) => syncEngine?.handleBackgroundTaskDelta(sessionId, delta),
        onBackgroundTaskCount: (sessionId, counts) => syncEngine?.handleBackgroundTaskCount(sessionId, counts),
        onSessionActivity: (sessionId, updatedAt) => syncEngine?.recordSessionActivity(sessionId, updatedAt),
        onSweepImmediateQueued: (sessionId, now) => syncEngine?.sweepImmediateQueuedOnSessionEnd(sessionId, now),
        onMessagesConsumed: (sessionId) => syncEngine?.clearQueuedThinkingGrace(sessionId)
    })

    syncEngine = new SyncEngine(store, socketServer.io, socketServer.rpcRegistry, sseManager)
    // Accountable principal for A2A work-graph notify ingest (P3).
    syncEngine.setHubOwnerUserId(await getOrCreateOwnerId())

    // Board orchestration: translates session signals into kanban column moves.
    // Started here, before any client can connect, because `start()` also
    // sweeps runs that a previous hub process left marked `running` - a card
    // stuck in that state has no other way out.
    taskOrchestrator = new TaskOrchestrator({
        store,
        getSession: (sessionId) => {
            const session = syncEngine?.getSession(sessionId)
            if (!session) return null
            return {
                id: session.id,
                namespace: session.namespace,
                active: session.active,
                thinking: session.thinking,
                agentState: session.agentState,
                backgroundTaskCount: session.backgroundTaskCount,
                backgroundAgentCount: session.backgroundAgentCount,
                backgroundAwaitedCount: session.backgroundAwaitedCount,
                worktree: session.metadata?.worktree ?? null,
                permissionMode: session.permissionMode
            }
        },
        spawnSession: async (input) => {
            if (!syncEngine) {
                return { type: 'error', message: 'Hub is still starting up' }
            }
            return await syncEngine.spawnSession(
                input.machineId,
                input.directory,
                input.flavor,
                input.model,
                input.modelReasoningEffort,
                input.yolo,
                input.sessionType,
                input.worktreeName,
                input.resumeSessionId,
                input.effort,
                input.permissionMode as PermissionMode | undefined,
                input.serviceTier,
                undefined,
                input.collaborationMode as CodexCollaborationMode | undefined,
                input.copilotAgentMode as CopilotAgentMode | undefined,
                undefined,
                { worktreeBaseRef: input.worktreeBaseRef }
            )
        },
        sendMessage: async (sessionId, text) => {
            if (!syncEngine) {
                throw new Error('Hub is still starting up')
            }
            await syncEngine.sendMessage(sessionId, { text, sentFrom: 'webapp' })
        },
        abortSession: async (sessionId) => {
            await syncEngine?.abortSession(sessionId)
        },
        reopenSession: async (sessionId, namespace) => {
            if (!syncEngine) return { type: 'error', message: 'Hub is still starting up' }
            const result = await syncEngine.reopenSession(sessionId, namespace)
            return result.type === 'success'
                ? { type: 'success', sessionId: result.sessionId }
                : { type: 'error', message: result.message }
        },
        renameSession: async (sessionId, name) => {
            await syncEngine?.renameSession(sessionId, name)
        },
        stopSession: async (machineId, sessionId) =>
            await syncEngine?.stopRunnerSession(machineId, sessionId),
        // Room membership is what delivery actually depends on, so it is what
        // gets asked -- the same read `messageService` uses to tell whether a
        // CLI is on the other end. A session flag would not do: `active` is set
        // optimistically when the spawn returns, which is precisely the moment
        // that is too early.
        isSessionAttached: (sessionId) =>
            (socketServer.io.of('/cli').adapter.rooms.get(`session:${sessionId}`)?.size ?? 0) > 0,
        subscribe: (listener) => syncEngine?.subscribe(listener) ?? (() => {}),
        onTaskChanged: (task) => sseManager?.broadcast(toTaskUpdatedEvent(task))
    })

    // One permanent assistant per workspace user.
    assistantService = new AssistantService({
        store,
        getSession: (sessionId, namespace) => syncEngine?.getSessionByNamespace(sessionId, namespace),
        listSessions: (namespace) => syncEngine?.getSessionsByNamespace(namespace) ?? [],
        onlineMachineIds: (namespace) => syncEngine?.getOnlineMachinesByNamespace(namespace).map((m) => m.id) ?? [],
        spawn: async (machineId, agent, extra) => {
            if (!syncEngine) {
                return { type: 'error', message: 'Hub is still starting up' }
            }
            // The runner ignores the directory for an assistant and picks its own.
            return await syncEngine.spawnSession(
                machineId, '(assistant)', agent, ASSISTANT_DEFAULT_MODEL[agent],
                undefined, undefined, 'simple', undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined, undefined,
                extra
            )
        },
        reopen: async (sessionId, namespace) => {
            if (!syncEngine) {
                return { type: 'error', message: 'Hub is still starting up' }
            }
            const result = await syncEngine.reopenSession(sessionId, namespace)
            if (result.type === 'success') return { type: 'success', sessionId: result.sessionId }
            return { type: 'error', message: result.message }
        },
        send: async (sessionId, payload) => {
            if (!syncEngine) {
                throw new Error('Hub is still starting up')
            }
            await syncEngine.sendMessage(sessionId, payload)
        },
        stop: async (sessionId) => {
            await syncEngine?.archiveSession(sessionId)
        },
        isSessionAttached: (sessionId) =>
            (socketServer.io.of('/cli').adapter.rooms.get(`session:${sessionId}`)?.size ?? 0) > 0
    })

    // Curate memory, then compact, when an assistant's context fills up.
    const assistantCompaction = new AssistantCompaction({
        getSession: (sessionId) => syncEngine?.getSession(sessionId),
        send: async (sessionId, text) => {
            await syncEngine?.sendMessage(sessionId, { text, sentFrom: 'webapp' })
        },
        onCompacted: (sessionId) => assistantService?.forgetContext(sessionId),
        logError: (message) => console.error(message),
        threshold: readCompactThreshold()
    })
    syncEngine.subscribe((event) => assistantCompaction.handle(event))

    // Worktree teardown when a card is deleted. Capability-gated: an older
    // runner has no such handler, and the board degrades to leaving the
    // worktree on disk rather than hanging on an RPC nobody answers.
    taskWorktree = new TaskWorktreeService({
        getMachineCapabilities: (machineId) =>
            syncEngine?.getMachine(machineId)?.metadata?.capabilities ?? null,
        removeWorktree: async (machineId, request) => {
            if (!syncEngine) throw new Error('Hub is still starting up')
            return await syncEngine.removeWorktree(machineId, request)
        }
    })
    taskOrchestrator.start()

    // Recurring runs: fires task schedules on their cron. Holds its first
    // fire for the orchestrator's reattach window, so a restart does not race
    // agents that are about to reconnect.
    const orchestrator = taskOrchestrator
    const worktreeService = taskWorktree
    taskScheduler = new TaskScheduler({
        store,
        startTask: (taskId, namespace, startOptions) => orchestrator.startTask(taskId, namespace, startOptions),
        continueTask: (taskId, namespace, continueOptions) => orchestrator.continueTask(taskId, namespace, continueOptions),
        getSession: (sessionId) => {
            const session = syncEngine?.getSession(sessionId)
            if (!session) return null
            return {
                id: session.id,
                namespace: session.namespace,
                active: session.active,
                thinking: session.thinking,
                agentState: session.agentState,
                backgroundTaskCount: session.backgroundTaskCount,
                backgroundAgentCount: session.backgroundAgentCount,
                backgroundAwaitedCount: session.backgroundAwaitedCount
            }
        },
        isMachineOnline: (machineId) => syncEngine?.getMachine(machineId)?.active === true,
        retireSession: (task) => orchestrator.retireSession(task),
        abortSession: async (sessionId) => {
            await syncEngine?.abortSession(sessionId)
        },
        removeRunWorktree: (task, worktree) =>
            worktreeService.teardown({ ...task, ...worktree }, { keepUnmerged: true }),
        notify: (sessionId, summary) => notificationHub?.notifyTaskSummary(sessionId, { summary, status: 'timed_out' }),
        onTaskChanged: (task) => sseManager?.broadcast(toTaskUpdatedEvent(task))
    })
    taskScheduler.start()

    // Review loop: pushes a task branch through the machine's session and opens
    // the pull request against its forge. Tokens are read per call so adding
    // one in Settings takes effect without a restart.
    taskReview = new TaskReviewService({
        store,
        runCommand: async (sessionId, commandOptions) => {
            if (!syncEngine) {
                return { success: false, error: 'Hub is still starting up' }
            }
            return await syncEngine.runBash(sessionId, commandOptions)
        },
        readTokens: async () => {
            const settings = await readSettingsOrThrow(getSettingsFile(config.dataDir))
            return settings.gitHostTokens
        },
        onTaskChanged: (task) => sseManager?.broadcast(toTaskUpdatedEvent(task))
    })

    const fcmConfig = resolveFcmConfig(config)

    // Build the optional FCM service early so the native-fallback probe
    // can consult its health gate. When FCM is configured, `fcmService` is
    // shared between the FcmNotificationChannel and the probe so a broken
    // pipeline (expired credentials, sustained 5xx) lets web-push run as
    // a last-resort surface for the namespace instead of silently muting
    // both channels.
    const fcmService = fcmConfig
        ? new FcmService(fcmConfig.projectId, fcmConfig.serviceAccount, store)
        : null

    const notificationChannels: NotificationChannel[] = []

    if (fcmConfig && fcmService) {
        notificationChannels.push(new FcmNotificationChannel(fcmService, sseManager, visibilityTracker, store))
        console.log('[Fcm] Native companion push enabled (project:', fcmConfig.projectId + ')')
    }

    // iOS push (P1): encrypt-then-route sibling of the FCM channel. Ordering
    // matters - both native channels run before PushNotificationChannel so a
    // successful native send sets the nativeGate and suppresses web-push.
    const iosPushConfig = resolveIosPushConfig(config)
    if (iosPushConfig.mode === 'relay') {
        const iosPushService = new IosPushService(new RelayClient(iosPushConfig.relayUrl), store)
        notificationChannels.push(new IosPushNotificationChannel(iosPushService, store))
        console.log(`[Hub] iOS push: relay (${iosPushConfig.source}, url: ${iosPushConfig.relayUrl})`)
    } else if (iosPushConfig.mode === 'apns') {
        const iosPushService = new IosPushService(new ApnsClient(iosPushConfig), store)
        notificationChannels.push(new IosPushNotificationChannel(iosPushService, store))
        console.log(`[Hub] iOS push: apns (${iosPushConfig.env}, topic: ${iosPushConfig.bundleId})`)
    } else {
        console.log(`[Hub] iOS push: off (${iosPushConfig.reason})`)
    }

    notificationChannels.push(
        new PushNotificationChannel(
            pushService,
            sseManager,
            visibilityTracker,
            config.publicUrl,
            new NativeNotificationComposer(store)
        )
    )

    if (config.serverChanSendKey && config.serverChanNotification) {
        notificationChannels.push(new ServerChanChannel(
            config.serverChanSendKey,
            config.publicUrl,
            visibilityTracker,
            config.serverChanBackgroundOnly
        ))
    }

    // Initialize Telegram bot (optional)
    if (config.telegramEnabled && config.telegramBotToken) {
        happyBot = new HappyBot({
            syncEngine,
            botToken: config.telegramBotToken,
            publicUrl: config.publicUrl,
            store
        })
        // Only add to notification channels if notifications are enabled
        if (config.telegramNotification) {
            notificationChannels.push(happyBot)
        }
    }

    notificationHub = new NotificationHub(syncEngine, notificationChannels, {
        suppressReady: (sessionId) => assistantCompaction.consumeQuietReady(sessionId)
    })

    // Start HTTP service first (before tunnel, so tunnel has something to forward to)
    webServer = await startWebServer({
        getSyncEngine: () => syncEngine,
        getTaskOrchestrator: () => taskOrchestrator,
        getAssistantService: () => assistantService,
        getTaskReview: () => taskReview,
        getTaskWorktree: () => taskWorktree,
        getTaskScheduler: () => taskScheduler,
        getSseManager: () => sseManager,
        getVisibilityTracker: () => visibilityTracker,
        jwtSecret,
        store,
        vapidPublicKey: vapidKeys.publicKey,
        socketEngine: socketServer.engine,
        corsOrigins,
        relayMode: relayFlag.enabled,
        officialWebUrl
    })

    // Start the bot if configured
    if (happyBot) {
        await happyBot.start()
    }

    console.log('')
    console.log('[Web] Hub listening on :' + config.listenPort)
    console.log('[Web] Local:  http://localhost:' + config.listenPort)

    // Initialize tunnel AFTER web service is ready
    let tunnelUrl: string | null = null
    if (relayFlag.enabled) {
        try {
            tunnelManager = new TunnelManager({
                localPort: config.listenPort,
                enabled: true,
                apiDomain: relayApiDomain,
                authKey: await resolveRelayAuthKey(relayApiDomain, config.settingsFile),
                refreshAuthKey: rejectedKey => refreshRejectedRelayAuthKey(
                    relayApiDomain,
                    config.settingsFile,
                    rejectedKey
                ),
                useRelay: process.env.DUGONG_RELAY_FORCE_TCP === 'true' || process.env.DUGONG_RELAY_FORCE_TCP === '1'
            })
            tunnelUrl = await tunnelManager.start()
        } catch (error) {
            console.error('[Tunnel] Failed to start:', error instanceof Error ? error.message : error)
            console.log('[Tunnel] Hub continuing without tunnel. Restart without --relay to disable.')
        }
    }

    if (tunnelUrl && tunnelManager) {
        const manager = tunnelManager
        const announceTunnelAccess = async () => {
            const tlsReady = await waitForTunnelTlsReady(tunnelUrl, manager)
            if (!tlsReady) {
                console.log('[Tunnel] Tunnel stopped before TLS was ready.')
                return
            }

            console.log('[Web] Public: ' + tunnelUrl)

            // Point at the tunnel itself, not the official web app: the board
            // only exists in this hub's own frontend.
            const params = new URLSearchParams({ token: config.cliApiToken })
            const directAccessUrl = `${tunnelUrl}/?${params.toString()}`

            console.log('')
            console.log('Open in browser:')
            console.log(`  ${directAccessUrl}`)
            console.log('')
            console.log('or scan the QR code to open:')

            // Display QR code for easy mobile access
            try {
                const qrString = await QRCode.toString(directAccessUrl, {
                    type: 'terminal',
                    small: true,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                })
                console.log('')
                console.log(qrString)
            } catch {
                // QR code generation failure should not affect main flow
            }
        }

        void announceTunnelAccess()
    }
    console.log('')
    console.log('dugong hub is ready!')

    return {
        stop: async () => {
            await tunnelManager?.stop()
            await happyBot?.stop()
            notificationHub?.stop()
            taskScheduler?.stop()
            taskOrchestrator?.stop()
            syncEngine?.stop()
            sseManager?.stop()
            webServer?.stop()
        }
    }
}
