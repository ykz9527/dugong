import type { ChatToolCall } from '@/chat/types'
import { isObject } from '@hapi/protocol'
import { isAskUserQuestionToolName, parseAskUserQuestionInput, type AskUserQuestionQuestion } from '@/components/ToolCard/askUserQuestion'
import { isCursorAskQuestionToolName, parseCursorAskQuestionInput } from '@/components/ToolCard/cursorAskQuestion'
import {
    AskUserQuestionOptionBody,
    getAskUserQuestionOptionFrameClassName
} from '@/components/ToolCard/askUserQuestionOptionCard'
import {
    isRequestUserInputToolName,
    parseRequestUserInputAnswers,
    parseRequestUserInputInput
} from '@/components/ToolCard/requestUserInput'
import { useTranslation } from '@/lib/use-translation'

export type AnsweredQuestionAnswer = {
    text: string
    /** Typed by the user rather than picked from the offered options. */
    custom: boolean
}

export type AnsweredQuestionItem = {
    key: string
    question: string | null
    answers: AnsweredQuestionAnswer[]
}

function toAnswerList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((answer): answer is string => typeof answer === 'string')
    }
    if (isObject(value) && Array.isArray(value.answers)) {
        return value.answers.filter((answer): answer is string => typeof answer === 'string')
    }
    return []
}

function toAnswers(raw: string[], question: AskUserQuestionQuestion | undefined): AnsweredQuestionAnswer[] {
    const answers: AnsweredQuestionAnswer[] = []
    for (const answer of raw) {
        const text = answer.trim()
        if (!text) continue
        // Cursor submits stable option ids; everyone else submits the label.
        const option = question?.options.find((opt) => opt.id?.trim() === text)
            ?? question?.options.find((opt) => opt.label.trim() === text)
        answers.push(option ? { text: option.label, custom: false } : { text, custom: true })
    }
    return answers
}

function getAskUserQuestionItems(tool: ChatToolCall): AnsweredQuestionItem[] {
    const answers = tool.permission?.answers
    if (!isObject(answers)) return []
    const { questions } = isCursorAskQuestionToolName(tool.name)
        ? parseCursorAskQuestionInput(tool.input)
        : parseAskUserQuestionInput(tool.input)

    if (questions.length === 0) {
        const freeform = toAnswers(toAnswerList(answers['0']), undefined)
        return freeform.length > 0 ? [{ key: '0', question: null, answers: freeform }] : []
    }

    const items: AnsweredQuestionItem[] = []
    questions.forEach((question, index) => {
        const id = question.id?.trim()
        const raw = toAnswerList((id ? answers[id] : undefined) ?? answers[String(index)])
        const list = toAnswers(raw, question)
        if (list.length === 0) return
        items.push({ key: id || String(index), question: question.question || question.header, answers: list })
    })
    return items
}

function parseResultAsAnswers(result: unknown): unknown {
    if (typeof result !== 'string') return result
    try {
        return JSON.parse(result)
    } catch {
        return undefined
    }
}

function getRequestUserInputItems(tool: ChatToolCall): AnsweredQuestionItem[] {
    const { questions } = parseRequestUserInputInput(tool.input)
    const raw = tool.permission?.answers ?? parseResultAsAnswers(tool.result)
    const parsed = raw ? parseRequestUserInputAnswers(raw, questions) : null
    if (!parsed) return []

    const items: AnsweredQuestionItem[] = []
    for (const question of questions) {
        const answer = parsed[question.id]
        if (!answer) continue
        const labels = new Set(question.options.map((option) => option.label))
        const list: AnsweredQuestionAnswer[] = answer.selected
            .filter((text) => text.trim().length > 0)
            .map((text) => ({ text, custom: !labels.has(text) }))
        const note = answer.userNote?.trim()
        if (note) list.push({ text: note, custom: true })
        if (list.length === 0) continue
        items.push({ key: question.id, question: question.question || null, answers: list })
    }
    return items
}

/** What the user answered on a finished question card. Empty while the
 *  question is still pending, so the answer footer stays the only input. */
export function getAnsweredQuestionItems(tool: ChatToolCall): AnsweredQuestionItem[] {
    if (!tool.permission || tool.permission.status === 'pending') return []
    if (isAskUserQuestionToolName(tool.name)) return getAskUserQuestionItems(tool)
    if (isRequestUserInputToolName(tool.name)) return getRequestUserInputItems(tool)
    return []
}

/** Inline answer list for a collapsed question card: the card header only
 *  carries the question, so without this the user's reply is invisible in
 *  the thread until the details dialog is opened. */
export function AnsweredQuestionsInline(props: { items: AnsweredQuestionItem[] }) {
    const { t } = useTranslation()
    const showQuestions = props.items.length > 1

    return (
        <div className="flex flex-col gap-3">
            {props.items.map((item) => (
                <div key={item.key} className="flex flex-col gap-1.5">
                    {showQuestions && item.question ? (
                        <div className="break-words text-xs text-[var(--app-hint)]">{item.question}</div>
                    ) : null}
                    {item.answers.map((answer, index) => (
                        <div key={index} className={getAskUserQuestionOptionFrameClassName(true)}>
                            <AskUserQuestionOptionBody
                                checked
                                mode="single"
                                showControl={false}
                                title={answer.text}
                                customLabel={answer.custom ? t('tool.customAnswer') : null}
                            />
                        </div>
                    ))}
                </div>
            ))}
        </div>
    )
}
