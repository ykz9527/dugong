import { useMemo, useState } from 'react'
import { assistantRequestToolId, isAssistantAlwaysAskTool, isAssistantGrantableTool } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import type { ChatToolCall, ToolPermission } from '@/chat/types'
import { usePlatform } from '@/hooks/usePlatform'
import { Spinner } from '@/components/Spinner'
import { getPermissionModeLabel, isCodexFamilyFlavor, isPermissionModeSwitchQueued } from '@hapi/protocol'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { getInputStringAny } from '@/lib/toolInputUtils'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function isToolAllowedForSession(toolName: string, toolInput: unknown, allowedTools: string[] | undefined): boolean {
    if (!allowedTools || allowedTools.length === 0) return false
    if (allowedTools.includes(toolName)) return true

    if (toolName === 'Bash') {
        const command = getInputStringAny(toolInput, ['command', 'cmd'])
        if (command) {
            return allowedTools.includes(`Bash(${command})`)
        }
    }

    return false
}

function isCodexSession(metadata: SessionMetadataSummary | null, toolName: string): boolean {
    return isCodexFamilyFlavor(metadata?.flavor)
        || metadata?.flavor === 'cursor'
        || toolName.startsWith('Codex')
        || toolName.startsWith('Gemini')
        || toolName.startsWith('OpenCode')
        || toolName.startsWith('Copilot')
        || toolName.startsWith('Cursor')
}

function isClaudeSession(metadata: SessionMetadataSummary | null): boolean {
    return metadata?.flavor === 'claude'
}

function formatPermissionSummary(permission: ToolPermission, toolName: string, toolInput: unknown, codex: boolean, t: (key: string) => string): string {
    if (permission.status === 'pending') return t('tool.waitingForApproval')
    if (permission.status === 'canceled') return permission.reason ? `${t('tool.canceled')}: ${permission.reason}` : t('tool.canceled')

    if (codex) {
        if (permission.status === 'approved' && permission.decision === 'approved_for_session') return t('tool.approvedForSession')
        if (permission.status === 'approved') return t('tool.approved')
        if (permission.status === 'denied' && permission.decision === 'abort') return permission.reason ? `${t('tool.aborted')}: ${permission.reason}` : t('tool.aborted')
        if (permission.status === 'denied') return permission.reason ? `${t('tool.deny')}: ${permission.reason}` : t('tool.deny')
        return t('tool.allow')
    }

    if (permission.status === 'approved') {
        if (permission.mode === 'acceptEdits') return t('tool.approvedAllowAllEdits')
        if (permission.decision === 'approved_for_session' || isToolAllowedForSession(toolName, toolInput, permission.allowedTools)) return t('tool.approvedForSession')
        return t('tool.approved')
    }

    if (permission.status === 'denied') {
        return permission.reason ? `${t('tool.deny')}: ${permission.reason}` : t('tool.deny')
    }

    return t('tool.allow')
}

function PermissionRowButton(props: {
    label: string
    tone: 'allow' | 'deny' | 'neutral' | 'muted'
    loading?: boolean
    disabled: boolean
    onClick: () => void
}) {
    return (
        <button
            type="button"
            className={cn(
                // Pills (DESIGN.md §6): approve is the black primary pill with the
                // red sweep; deny is red text; the rest are outline pills.
                'inline-flex min-h-9 max-w-full items-center gap-2 rounded-full px-4 py-1.5 text-left transition-colors duration-[var(--dur-fast)] disabled:pointer-events-none disabled:opacity-50',
                props.tone === 'allow'
                    ? 'pw-sweep bg-[var(--app-button)] text-[var(--app-button-text)]'
                    : props.tone === 'deny'
                        ? 'pw-row-fill overflow-hidden border border-[var(--app-border)] text-[var(--app-accent)]'
                        : props.tone === 'muted'
                            ? 'pw-row-fill overflow-hidden border border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                            : 'pw-row-fill overflow-hidden border border-[var(--app-border)] text-[var(--app-fg)]'
            )}
            disabled={props.disabled}
            aria-busy={props.loading === true}
            onClick={props.onClick}
        >
            <span className="min-w-0 text-[13px] font-semibold leading-tight break-words">
                {props.label}
            </span>
            {props.loading ? (
                <span className="shrink-0">
                    <Spinner size="sm" label={null} className="text-current" />
                </span>
            ) : null}
        </button>
    )
}

export function PermissionFooter(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const [loading, setLoading] = useState<'allow' | 'deny' | 'abort' | null>(null)
    const [loadingAllEdits, setLoadingAllEdits] = useState(false)
    const [loadingForSession, setLoadingForSession] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const codex = useMemo(() => isCodexSession(props.metadata, props.tool.name), [props.metadata, props.tool.name])
    const claude = useMemo(() => isClaudeSession(props.metadata), [props.metadata])

    // Why am I still being asked, when I switched this session to Auto?
    // Because `auto` and `plan` are flags on the agent process, so a switch
    // made during a turn cannot bind until the next one starts. The composer
    // says so too, but only inside a sheet the operator has already closed by
    // the time the next request arrives — this is where the question is asked.
    // Optional context: the card also renders in tests and previews with no
    // chat provider around it, where there is nothing to report.
    const chat = useOptionalHappyChatContext()
    const selectedPermissionMode = chat?.permissionMode
    const runningPermissionMode = chat?.activePermissionMode
    const permissionModeIsQueued = Boolean(
        selectedPermissionMode
        && runningPermissionMode
        && isPermissionModeSwitchQueued({
            selected: selectedPermissionMode,
            active: runningPermissionMode,
            flavor: props.metadata?.flavor
        })
    )

    if (!permission) return null

    const summary = formatPermissionSummary(permission, props.tool.name, props.tool.input, codex, t)
    const isPending = permission.status === 'pending'

    const run = async (action: () => Promise<void>, hapticType: 'success' | 'error') => {
        if (props.disabled) return
        setError(null)
        try {
            await action()
            haptic.notification(hapticType)
            props.onDone()
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : t('tool.requestFailed'))
        }
    }

    const toolName = props.tool.name
    const isEditTool = toolName === 'Edit'
        || toolName === 'MultiEdit'
        || toolName === 'Write'
        || toolName === 'NotebookEdit'
    const hideAllowForSession = toolName === 'Edit'
        || toolName === 'MultiEdit'
        || toolName === 'Write'
        || toolName === 'NotebookEdit'
        || toolName === 'exit_plan_mode'
        || toolName === 'ExitPlanMode'
        || toolName === 'CursorCreatePlan'
    // A plan is accepted or sent back, the same for every agent: "for session"
    // and "abort" mean nothing for it.
    const isPlanProposal = toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode'
    const codexButtons = codex && !isPlanProposal

    // The assistant's session never ends, so for its grantable tools the hub
    // records "for session" as a standing grant; say so on the button. Its
    // always-ask tools get no such button: the person decides every time.
    const assistantTool = props.metadata?.role === 'assistant'
        ? assistantRequestToolId(toolName, props.tool.input)
        : null
    const remembersForGood = assistantTool !== null && isAssistantGrantableTool(assistantTool)
    const alwaysAsk = assistantTool !== null && isAssistantAlwaysAskTool(assistantTool)
    const canAllowForSession = !codex && isPending && !hideAllowForSession && !alwaysAsk
    const canAllowAllEdits = claude && isPending && isEditTool

    const approve = async () => {
        if (!isPending || loading || loadingAllEdits || loadingForSession) return
        setLoading('allow')
        await run(() => props.api.approvePermission(props.sessionId, permission.id), 'success')
        setLoading(null)
    }

    const approveAllEdits = async () => {
        if (!isPending || loading || loadingAllEdits || loadingForSession) return
        setLoadingAllEdits(true)
        await run(() => props.api.approvePermission(props.sessionId, permission.id, 'acceptEdits'), 'success')
        setLoadingAllEdits(false)
    }

    const approveForSession = async () => {
        if (!canAllowForSession || loading || loadingAllEdits || loadingForSession) return
        setLoadingForSession(true)
        if (claude) {
            const command = toolName === 'Bash' ? getInputStringAny(props.tool.input, ['command', 'cmd']) : null
            const toolIdentifier = toolName === 'Bash' && command ? `Bash(${command})` : toolName
            await run(() => props.api.approvePermission(props.sessionId, permission.id, { allowTools: [toolIdentifier] }), 'success')
        } else {
            await run(() => props.api.approvePermission(props.sessionId, permission.id, { decision: 'approved_for_session' }), 'success')
        }
        setLoadingForSession(false)
    }

    const deny = async () => {
        if (!isPending || loading || loadingAllEdits || loadingForSession) return
        setLoading('deny')
        // Codex reads a bare deny as abort; say decline so the turn goes on.
        await run(() => props.api.denyPermission(props.sessionId, permission.id, codex ? { decision: 'denied' } : undefined), 'success')
        setLoading(null)
    }

    const codexApprove = async (decision: 'approved' | 'approved_for_session') => {
        if (!isPending || loading || loadingForSession) return
        if (decision === 'approved_for_session') {
            setLoadingForSession(true)
            await run(() => props.api.approvePermission(props.sessionId, permission.id, { decision }), 'success')
            setLoadingForSession(false)
            return
        }
        setLoading('allow')
        await run(() => props.api.approvePermission(props.sessionId, permission.id, { decision }), 'success')
        setLoading(null)
    }

    const codexAbort = async () => {
        if (!isPending || loading || loadingForSession) return
        setLoading('abort')
        await run(() => props.api.denyPermission(props.sessionId, permission.id, { decision: 'abort' }), 'success')
        setLoading(null)
    }

    if (!isPending) {
        // Keep the thread minimal: approval is already reflected by tool state/icon.
        // Only surface a short message when the permission was denied/canceled and we have a reason.
        if (permission.status !== 'denied' && permission.status !== 'canceled') return null
        if (!permission.reason) return null

        return (
            <div className="mt-2 text-xs text-[var(--app-accent)]">
                {permission.reason}
            </div>
        )
    }

    return (
        <div className="mt-1 border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="text-xs font-semibold text-[var(--app-accent)]">{summary}</div>

            {permissionModeIsQueued ? (
                <div className="mt-2 border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] px-3 py-2 text-xs text-[var(--app-badge-warning-text)]">
                    {t('tool.permissionModeQueued', {
                        active: getPermissionModeLabel(runningPermissionMode!),
                        mode: getPermissionModeLabel(selectedPermissionMode!)
                    })}
                </div>
            ) : null}

            {error ? (
                <div className="mt-2 text-xs text-[var(--app-accent)]">
                    {error}
                </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                {codexButtons ? (
                    <>
                        <PermissionRowButton
                            label={t('tool.yes')}
                            tone="allow"
                            loading={loading === 'allow'}
                            disabled={props.disabled || loading !== null || loadingForSession}
                            onClick={() => codexApprove('approved')}
                        />
                        {alwaysAsk ? null : (
                            <PermissionRowButton
                                label={remembersForGood ? t('tool.allowAndRemember') : t('tool.yesForSession')}
                                tone="muted"
                                loading={loadingForSession}
                                disabled={props.disabled || loading !== null || loadingForSession}
                                onClick={() => codexApprove('approved_for_session')}
                            />
                        )}
                        <PermissionRowButton
                            label={t('tool.abortLabel')}
                            tone="deny"
                            loading={loading === 'abort'}
                            disabled={props.disabled || loading !== null || loadingForSession}
                            onClick={codexAbort}
                        />
                    </>
                ) : (
                    <>
                        <PermissionRowButton
                            label={t('tool.allow')}
                            tone="allow"
                            loading={loading === 'allow'}
                            disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                            onClick={approve}
                        />
                        {canAllowForSession ? (
                            <PermissionRowButton
                                label={remembersForGood ? t('tool.allowAndRemember') : t('tool.allowForSession')}
                                tone="muted"
                                loading={loadingForSession}
                                disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                                onClick={approveForSession}
                            />
                        ) : null}
                        {canAllowAllEdits ? (
                            <PermissionRowButton
                                label={t('tool.allowAll')}
                                tone="muted"
                                loading={loadingAllEdits}
                                disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                                onClick={approveAllEdits}
                            />
                        ) : null}
                        <PermissionRowButton
                            label={t('tool.deny')}
                            tone="deny"
                            loading={loading === 'deny'}
                            disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                            onClick={deny}
                        />
                    </>
                )}
            </div>
        </div>
    )
}
