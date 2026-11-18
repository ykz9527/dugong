import type { ToolCallBlock } from '@/chat/types'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { getRunnableShellCommand } from '@/components/ToolCard/shellCommand'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

/**
 * Hands a shell tool call's command to the session's terminal, typed at the
 * prompt but not run — for what the agent could not do itself (sudo, a
 * password prompt). Renders nothing when the session has no terminal.
 */
export function RunInTerminalButton(props: { block: ToolCallBlock; onDone?: () => void; className?: string }) {
    const { t } = useTranslation()
    const onRunInTerminal = useOptionalHappyChatContext()?.onRunInTerminal
    const command = getRunnableShellCommand(props.block.tool.name, props.block.tool.input)
    if (!onRunInTerminal || !command) {
        return null
    }
    return (
        <button
            type="button"
            onClick={() => {
                onRunInTerminal(command)
                props.onDone?.()
            }}
            className={cn(
                'pw-ghost-sweep inline-flex h-7 items-center self-start rounded-full border border-[var(--app-fg)] px-3 text-xs font-semibold',
                props.className
            )}
        >
            {t('tool.runInTerminal')}
        </button>
    )
}
