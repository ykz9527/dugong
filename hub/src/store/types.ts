import type {
    AssistantMemoryAuthor,
    AssistantMemoryScope,
    AssistantMemorySnapshot,
    AssistantMemoryType,
    AssistantQuestion
} from '@hapi/protocol'

export type StoredSession = {
    id: string
    tag: string | null
    namespace: string
    machineId: string | null
    createdAt: number
    updatedAt: number
    pinned: boolean
    globalPinned: boolean
    metadata: unknown | null
    metadataVersion: number
    agentState: unknown | null
    agentStateVersion: number
    model: string | null
    modelReasoningEffort: string | null
    effort: string | null
    serviceTier: string | null
    todos: unknown | null
    todosUpdatedAt: number | null
    teamState: unknown | null
    teamStateUpdatedAt: number | null
    active: boolean
    activeAt: number | null
    seq: number
}

export type StoredMachine = {
    id: string
    namespace: string
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    runnerState: unknown | null
    runnerStateVersion: number
    active: boolean
    activeAt: number | null
    seq: number
}

export type MessageDeliveryState = 'indeterminate'

export type StoredMessage = {
    id: string
    sessionId: string
    content: unknown
    createdAt: number
    seq: number
    localId: string | null
    invokedAt: number | null
    scheduledAt: number | null
    /** Omitted for ordinary queued/delivered rows; set when steer outcome is unknown. */
    deliveryState?: MessageDeliveryState
}

export type StoredUser = {
    id: number
    platform: string
    platformUserId: string
    namespace: string
    createdAt: number
}

/**
 * Workspace user row (schema v28). Board / session-list scoping, not auth —
 * `paths` are the root directories that mark work as this person's.
 */
export type StoredWorkspaceUser = {
    id: string
    namespace: string
    name: string
    paths: string[]
    createdAt: number
    updatedAt: number
}

export type StoredAssistantMemory = {
    id: string
    namespace: string
    workspaceUserId: string
    scope: AssistantMemoryScope
    scopeRef: string
    name: string
    description: string
    type: AssistantMemoryType
    body: string
    createdBy: AssistantMemoryAuthor
    lastEditedBy: AssistantMemoryAuthor
    source: { sessionId: string; messageSeq: number | null } | null
    previous: AssistantMemorySnapshot | null
    createdAt: number
    updatedAt: number
}

export type StoredAssistantQuestion = AssistantQuestion

export type StoredAssistantGrant = {
    id: string
    workspaceUserId: string
    tool: string
    createdAt: number
}

export type StoredPushSubscription = {
    id: number
    namespace: string
    endpoint: string
    p256dh: string
    auth: string
    /**
     * Whose screen this browser is filtered to, or null for "not filtered".
     * Null is what every row registered before schema v29 carries, and it
     * means the target still receives every notification in the namespace.
     */
    workspaceUserId: string | null
    createdAt: number
}

export type NativeDevicePlatform = 'phone' | 'wear' | 'ios'

export type StoredFcmDevice = {
    id: number
    namespace: string
    /** FCM registration token (phone/wear) or hex APNs device token (ios). */
    token: string
    platform: NativeDevicePlatform
    deviceId: string
    /**
     * base64 of the device-generated 32-byte E2E push encryption key.
     * Required for `ios` rows (PUSH SPEC v1 envelope); always null for
     * phone/wear rows.
     */
    pushKey: string | null
    /** See `StoredPushSubscription.workspaceUserId`. */
    workspaceUserId: string | null
    createdAt: number
    updatedAt: number
}

export type StoredScratchlistEntry = {
    sessionId: string
    entryId: string
    text: string
    createdAt: number
    updatedAt: number
    attachments: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
}

/**
 * Board task row. `spawn` is the parsed `TaskSpawnConfig` JSON blob; the SQL
 * layer keeps it opaque (`unknown`) the same way `StoredSession.metadata`
 * does, and the route layer validates with `TaskSpawnConfigSchema`.
 */
export type StoredTask = {
    id: string
    namespace: string
    title: string
    prompt: string
    /** Stored in the `column_id` SQL column - `column` is an SQLite keyword. */
    column: string
    machineId: string | null
    workdir: string
    isolation: string
    worktreeName: string | null
    baseRef: string | null
    branch: string | null
    worktreePath: string | null
    spawn: unknown
    currentSessionId: string | null
    lastRunId: string | null
    lastRunStatus: string | null
    lastError: string | null
    /** Parsed `TaskPullRequest` JSON, or null before a PR exists. */
    pullRequest: unknown | null
    archivedAt: number | null
    createdAt: number
    updatedAt: number
    seq: number
}

export type StoredTaskRun = {
    id: string
    taskId: string
    sessionId: string | null
    status: string
    origin: string
    baseRef: string | null
    baseCommit: string | null
    branch: string | null
    worktreePath: string | null
    startedAt: number
    endedAt: number | null
    error: string | null
}

export type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }
