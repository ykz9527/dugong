import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { useTranslation } from '@/lib/use-translation'

export type SideQuestionState = {
    id: number
    question: string
} & (
    | { status: 'pending' }
    | { status: 'done'; answer: string }
    | { status: 'error'; error: string }
)

/** `/btw <question>` → question; `null` when the text is not a /btw command. */
export function parseSideQuestion(text: string): string | null {
    const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim())
    return match ? (match[1] ?? '').trim() : null
}

/**
 * Ephemeral answer for Claude `/btw`: never enters the chat transcript,
 * gone on dismiss — same contract as the TUI overlay.
 */
export function SideQuestionPanel(props: {
    state: SideQuestionState | null
    onDismiss: () => void
}) {
    const { t } = useTranslation()
    const { state } = props
    if (!state) return null
    return (
        <div className="px-3 pb-2" data-testid="side-question-panel">
            <div
                role="status"
                aria-live="polite"
                className="mx-auto flex w-full max-w-content flex-col gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-text)]"
            >
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 text-xs text-[var(--app-hint)]">
                        <span className="font-medium">/btw</span>{' '}
                        <span className="break-words">{state.question}</span>
                    </div>
                    <button
                        type="button"
                        onClick={props.onDismiss}
                        className="shrink-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                    >
                        {t('sideQuestion.dismiss')}
                    </button>
                </div>
                <div className="max-h-[40vh] overflow-y-auto">
                    {state.status === 'pending' ? (
                        <div className="text-[var(--app-hint)]">{t('sideQuestion.pending')}</div>
                    ) : state.status === 'error' ? (
                        <div className="text-red-600">{state.error}</div>
                    ) : (
                        <MarkdownRenderer content={state.answer} standalone />
                    )}
                </div>
                <div className="text-[11px] text-[var(--app-hint)]">{t('sideQuestion.footnote')}</div>
            </div>
        </div>
    )
}
