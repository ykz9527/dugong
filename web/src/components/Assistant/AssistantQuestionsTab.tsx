import { useState, type CSSProperties } from 'react'
import { toAssistantToolId, type AssistantGrant, type AssistantQuestion } from '@hapi/protocol'
import type { useAnswerAssistantQuestion } from '@/hooks/queries/useAssistant'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'

/**
 * Decisions the assistant made without the person, waiting to be checked.
 * The assistant has already gone ahead with its pick: keeping it just closes
 * the question, anything else sends the assistant back to undo and redo.
 */

type Answer = ReturnType<typeof useAnswerAssistantQuestion>

const ANSWERED_SHOWN = 20

/**
 * Without these the assistant stops on a confirm card each time it pushes a
 * task along. Only grantable tools: answering a task's prompt always asks.
 */
const DRIVING_TOOLS = ['ping_peer'].map(toAssistantToolId)

export function AssistantQuestionsTab(props: {
    questions: AssistantQuestion[]
    grants: AssistantGrant[]
    taskTitles: Map<string, string>
    answer: Answer
}) {
    const { t } = useTranslation()
    // Lives here, not on the card: a card leaves the list as soon as it is answered.
    const [reworkError, setReworkError] = useState<string | null>(null)
    const open = props.questions.filter((question) => question.status === 'open')
    const answered = props.questions.filter((question) => question.status !== 'open').slice(0, ANSWERED_SHOWN)
    const granted = new Set(props.grants.map((grant) => grant.tool))
    const missingGrants = DRIVING_TOOLS.some((tool) => !granted.has(tool))

    return (
        <div className="app-scroll-y min-h-0 flex-1 px-4 pb-3 pt-2">
            {missingGrants ? (
                <p className="pb-2 text-xs text-[var(--app-hint)]">
                    {t('assistant.questions.grantHint')}
                </p>
            ) : null}
            {reworkError ? (
                <p className="pb-2 text-xs text-[var(--app-accent)]">
                    {t('assistant.questions.reworkFailed', { error: reworkError })}
                </p>
            ) : null}
            {props.answer.error ? (
                <p role="alert" className="pb-2 text-xs text-[var(--app-accent)]">{props.answer.error}</p>
            ) : null}

            {open.length === 0 ? (
                <div className="py-8 text-center text-[13px] text-[var(--app-hint)]">
                    <p className="text-[15px] text-[var(--app-fg)]">{t('assistant.questions.empty')}</p>
                    <p className="mt-1">{t('assistant.questions.emptyHint')}</p>
                </div>
            ) : open.map((question, index) => (
                <OpenQuestion
                    key={question.id}
                    index={index}
                    question={question}
                    taskTitle={question.taskId ? props.taskTitles.get(question.taskId) ?? null : null}
                    answer={props.answer}
                    onReworkError={setReworkError}
                />
            ))}
            {open.length > 0 ? <div className="border-t border-[var(--app-border)]" /> : null}

            {answered.length > 0 ? (
                <section className="border-b border-[var(--app-border)]">
                    <h3 className="pw-eyebrow flex items-baseline gap-2 pb-2 pt-6 text-[var(--app-fg)]">
                        {t('assistant.questions.answered')}
                        <span className="tabular-nums text-[var(--app-hint)]">{answered.length}</span>
                    </h3>
                    {answered.map((question, index) => (
                        <div key={question.id} className="pw-ledger flex items-baseline gap-3 py-2 text-[13px]" style={{ '--i': index } as CSSProperties}>
                            <span className="min-w-0 flex-1 truncate text-[var(--app-fg)]" title={question.question}>{question.question}</span>
                            <span className="max-w-[45%] shrink-0 truncate text-xs text-[var(--app-hint)]">
                                {question.status === 'withdrawn'
                                    ? t('assistant.questions.status.withdrawn')
                                    : question.status === 'confirmed'
                                        ? t('assistant.questions.status.confirmed', { answer: question.answer ?? '' })
                                        : t('assistant.questions.status.overridden', { answer: question.answer ?? '' })}
                            </span>
                        </div>
                    ))}
                </section>
            ) : null}
        </div>
    )
}

function OpenQuestion(props: {
    index: number
    question: AssistantQuestion
    taskTitle: string | null
    answer: Answer
    onReworkError: (error: string | null) => void
}) {
    const { t } = useTranslation()
    const { question } = props
    const [picked, setPicked] = useState(question.chosen)
    const [other, setOther] = useState('')
    const isOther = picked === ''
    const reply = isOther ? other.trim() : picked
    const changed = reply !== question.chosen

    const submit = async (answer: string) => {
        try {
            const result = await props.answer.answer({ id: question.id, answer })
            props.onReworkError(result.reworkError)
        } catch {
            // Shown through `answer.error`; the question stays open to retry.
        }
    }

    return (
        <article className="pw-ledger py-3 text-[13px]" style={{ '--i': props.index } as CSSProperties}>
            <div className="flex items-baseline gap-2 text-xs text-[var(--app-hint)]">
                {props.taskTitle ? <span className="min-w-0 truncate">{props.taskTitle}</span> : null}
                <span className="flex-1" />
                <span className="shrink-0">{formatRelativeTime(question.createdAt, t)}</span>
            </div>
            <p className="mt-1 text-[15px] font-medium tracking-[-0.005em] text-[var(--app-fg)]">{question.question}</p>

            <div className="mt-2 flex flex-col gap-1.5" role="radiogroup">
                {question.options.map((option) => (
                    <label key={option} className="flex cursor-pointer items-baseline gap-2">
                        <input type="radio" className="accent-[var(--app-fg)]" name={question.id} checked={picked === option} onChange={() => setPicked(option)} />
                        <span className="text-[var(--app-fg)]">{option}</span>
                        {option === question.chosen ? (
                            <span className="pw-eyebrow text-[var(--app-hint)]">{t('assistant.questions.chosen')}</span>
                        ) : null}
                    </label>
                ))}
                <label className="flex cursor-pointer items-center gap-2">
                    <input type="radio" className="accent-[var(--app-fg)]" name={question.id} checked={isOther} onChange={() => setPicked('')} />
                    <input
                        value={other}
                        onFocus={() => setPicked('')}
                        onChange={(event) => setOther(event.target.value)}
                        placeholder={t('assistant.questions.other')}
                        className="min-w-0 flex-1 border-0 border-b border-[var(--app-rule)] bg-transparent px-0 py-0.5 text-[var(--app-fg)] placeholder-[var(--app-hint)] transition-[border-color] duration-300 focus:border-[var(--app-accent)] focus:outline-none"
                    />
                </label>
            </div>

            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="font-semibold text-[var(--app-hint)]">{t('assistant.questions.rationale')}</dt>
                <dd className="text-[var(--app-fg)]">{question.rationale}</dd>
                <dt className="font-semibold text-[var(--app-hint)]">{t('assistant.questions.rollback')}</dt>
                <dd className="text-[var(--app-fg)]">{question.rollback}</dd>
            </dl>

            <div className="mt-3 flex justify-end gap-2">
                <button
                    type="button"
                    disabled={props.answer.isPending}
                    onClick={() => void submit(question.chosen)}
                    className="pw-ghost-sweep rounded-full border border-[var(--app-fg)] px-3 py-1 text-xs font-semibold text-[var(--app-fg)] disabled:opacity-50"
                >
                    {t('assistant.questions.keep')}
                </button>
                <button
                    type="button"
                    disabled={props.answer.isPending || !changed || reply === ''}
                    onClick={() => void submit(reply)}
                    className="pw-sweep rounded-full bg-[var(--app-button)] px-3 py-1 text-xs font-semibold text-[var(--app-button-text)] disabled:opacity-50"
                >
                    {t('assistant.questions.change')}
                </button>
            </div>
        </article>
    )
}
