import type { AgentFlavor } from '@hapi/protocol'
import type { CopilotAgentMode } from '@hapi/protocol'

export interface SpawnSessionOptions {
    machineId?: string
    directory: string
    sessionId?: string
    // Existing hub session id to reuse (reopen/resume). Distinct from the legacy
    // `sessionId` field above (reserved/unused by spawn): when set, the CLI boots
    // with `--hapi-session-id` so the child reuses the existing hub row (stable
    // id) instead of minting a new one. Set only by the hub reopen/resume path.
    existingSessionId?: string
    resumeSessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: AgentFlavor
    model?: string
    effort?: string
    modelReasoningEffort?: string
    yolo?: boolean
    permissionMode?: string
    serviceTier?: string
    collaborationMode?: 'default' | 'plan'
    copilotAgentMode?: CopilotAgentMode
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    /** Commit-ish the task's worktree branch starts from. See `createWorktree`. */
    worktreeBaseRef?: string
    startingMode?: 'remote' | 'pty'
    /** Claude: spawn with --fork-session after --resume. */
    forkSession?: boolean
    /**
     * Spawn a workspace user's task assistant. The
     * runner picks the directory itself — `<DUGONG_HOME>/assistant/<id>` — and
     * passes only those `addDirs` that sit inside its workspace roots.
     */
    assistant?: { workspaceUserId: string; addDirs: string[] }
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }
