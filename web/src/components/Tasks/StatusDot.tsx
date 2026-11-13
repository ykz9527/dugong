import type { TaskColumn } from '@hapi/protocol'

/**
 * The one place a column turns into a colour.
 *
 * Shared by the task list and the assistant panel, so the two cannot drift.
 *
 * Three tones, the template's whole palette: red for the two columns that want
 * a human (review, blocked), black for live work, grey for the rest. Running
 * pulses so a live agent is visible without a colour of its own.
 */

export type ColumnTone = {
    /** The dot itself. */
    dot: string
    /** Heading text. */
    text: string
    /** Left rule on a row or card. */
    bar: string
    /** Row wash. Empty for the columns that should not pull the eye. */
    tint: string
}

const HOT: ColumnTone = {
    dot: 'bg-[var(--app-accent)]',
    text: 'text-[var(--app-accent)]',
    bar: 'border-l-[var(--app-accent)]',
    tint: 'bg-[var(--app-accent-soft)]'
}

const QUIET: ColumnTone = {
    dot: 'bg-[var(--p-grey-3)]',
    text: 'text-[var(--app-hint)]',
    bar: 'border-l-[var(--app-border)]',
    tint: ''
}

const COLUMN_TONES: Record<TaskColumn, ColumnTone> = {
    review: HOT,
    blocked: HOT,
    running: { ...QUIET, dot: 'bg-[var(--app-fg)] animate-pulse', bar: 'border-l-[var(--app-fg)]' },
    ready: { ...QUIET, dot: 'bg-[var(--app-fg)]', bar: 'border-l-[var(--app-fg)]' },
    backlog: QUIET,
    done: QUIET
}

export function taskColumnTone(column: TaskColumn): ColumnTone {
    return COLUMN_TONES[column]
}

export function StatusDot(props: { column: TaskColumn; className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${taskColumnTone(props.column).dot} ${props.className ?? ''}`}
        />
    )
}
