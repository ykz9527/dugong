export const queryKeys = {
    sessions: ['sessions'] as const,
    session: (sessionId: string) => ['session', sessionId] as const,
    messages: (sessionId: string) => ['messages', sessionId] as const,
    machines: ['machines'] as const,
    sqliteStorage: ['sqlite-storage'] as const,
    hubSettings: ['hub-settings'] as const,
    usageSummary: (range: string, timeZone: string) => ['usage-summary', range, timeZone] as const,
    machineCodexModels: (machineId: string) => ['machine-codex-models', machineId] as const,
    sessionCodexModels: (sessionId: string) => ['session-codex-models', sessionId] as const,
    gitStatus: (sessionId: string) => ['git-status', sessionId] as const,
    sessionFiles: (sessionId: string, query: string) => ['session-files', sessionId, query] as const,
    sessionDirectory: (sessionId: string, path: string) => ['session-directory', sessionId, path] as const,
    sessionFile: (sessionId: string, path: string) => ['session-file', sessionId, path] as const,
    gitFileDiff: (sessionId: string, path: string, staged?: boolean) => [
        'git-file-diff',
        sessionId,
        path,
        staged ? 'staged' : 'unstaged'
    ] as const,
    slashCommands: (sessionId: string) => ['slash-commands', sessionId] as const,
    sessionCursorModels: (sessionId: string) => ['session-cursor-models', sessionId] as const,
    sessionCursorChatStore: (sessionId: string) => ['session-cursor-chat-store', sessionId] as const,
    sessionPiModels: (sessionId: string) => ['session-pi-models', sessionId] as const,
    machineCursorModels: (machineId: string) => ['machine-cursor-models', machineId] as const,
    sessionOpencodeModels: (sessionId: string) => ['session-opencode-models', sessionId] as const,
    sessionOpencodeReasoningEffortOptions: (sessionId: string) => ['session-opencode-reasoning-effort-options', sessionId] as const,
    machineOpencodeModelsForCwd: (machineId: string, cwd: string) => ['machine-opencode-models', machineId, cwd] as const,
    machineGrokModelsForCwd: (machineId: string, cwd: string) => ['machine-grok-models', machineId, cwd] as const,
    sessionGrokModels: (sessionId: string) => ['session-grok-models', sessionId] as const,
    sessionCopilotModels: (sessionId: string) => ['session-copilot-models', sessionId] as const,
    machineCopilotModelsForCwd: (machineId: string, cwd: string) => ['machine-copilot-models', machineId, cwd] as const,
    sessionGrokReasoningEffortOptions: (sessionId: string) => ['session-grok-reasoning-effort-options', sessionId] as const,
    machineAgyModels: (machineId: string) => ['machine-agy-models', machineId] as const,
    machinePiModels: (machineId: string) => ['machine-pi-models', machineId] as const,
    skills: (sessionId: string) => ['skills', sessionId] as const,
    scratchlist: (sessionId: string) => ['scratchlist', sessionId] as const,
    workspaceUsers: ['workspace-users'] as const,
    // Task assistant, per workspace user. One prefix so an SSE nudge can drop
    // everything a person's assistant shows.
    assistant: (workspaceUserId: string) => ['assistant', workspaceUserId] as const,
    assistantSession: (workspaceUserId: string) => ['assistant', workspaceUserId, 'session'] as const,
    assistantMemories: (workspaceUserId: string) => ['assistant', workspaceUserId, 'memories'] as const,
    assistantGrants: (workspaceUserId: string) => ['assistant', workspaceUserId, 'grants'] as const,
    assistantQuestions: (workspaceUserId: string) => ['assistant', workspaceUserId, 'questions'] as const,
    // Board keys share the 'tasks' prefix so one SSE-driven invalidation
    // covers every filtered variant of the list.
    tasks: ['tasks'] as const,
    // Prefix that matches every list variant but NOT `task(id)` detail entries —
    // they share the 'tasks' root but hold a different shape.
    taskLists: ['tasks', 'list'] as const,
    taskList: (filter: string) => ['tasks', 'list', filter] as const,
    task: (taskId: string) => ['tasks', 'detail', taskId] as const,
    // Under the 'tasks' root on purpose: a run starting or ending moves a
    // schedule's history and cursor, and the board's task invalidation then
    // refreshes these too.
    taskSchedules: (workspaceUserId: string) => ['tasks', 'schedules', workspaceUserId] as const,
    taskSchedule: (taskId: string) => ['tasks', 'schedule', taskId] as const,
    taskScheduleSlots: (taskId: string) => ['tasks', 'schedule-slots', taskId] as const,
}
