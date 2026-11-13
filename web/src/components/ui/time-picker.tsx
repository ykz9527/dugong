import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'

/**
 * Hour / minute picking in the app's own style.
 *
 * The browser's `<input type="time">` opens a native popup that looks like
 * nothing else in the app and differs per browser and phone. `TimeColumns` is
 * the inline form (two scrolling columns); `TimePickerField` puts it behind a
 * trigger showing the chosen time.
 */

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

const pad = (value: number) => String(value).padStart(2, '0')

export function parseTime(time: string): { hour: number; minute: number } {
    const [hour = '0', minute = '0'] = time.split(':')
    return { hour: Math.min(23, Math.max(0, Number(hour) || 0)), minute: Math.min(59, Math.max(0, Number(minute) || 0)) }
}

function formatTime(hour: number, minute: number): string {
    return `${pad(hour)}:${pad(minute)}`
}

function Column(props: {
    values: readonly number[]
    selected: number
    label: string
    onPick: (value: number) => void
    stretch?: boolean
}) {
    const listRef = useRef<HTMLDivElement>(null)

    // Bring the chosen value into view when the column appears.
    useEffect(() => {
        const list = listRef.current
        const item = list?.querySelector<HTMLElement>('[data-selected="true"]')
        if (list && item) list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.clientHeight / 2
    }, [])

    return (
        <div
            ref={listRef}
            role="listbox"
            aria-label={props.label}
            className={`relative flex h-44 flex-col gap-0.5 overflow-y-auto overscroll-contain py-1 [scrollbar-width:thin] ${props.stretch ? 'flex-1' : 'w-14'}`}
        >
            {props.values.map((value) => {
                const selected = value === props.selected
                return (
                    <button
                        key={value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-selected={selected}
                        onClick={() => props.onPick(value)}
                        className={`mx-1 shrink-0 rounded-md py-1 text-center text-sm tabular-nums transition-colors ${
                            selected
                                ? 'bg-[var(--app-link)] font-medium text-[var(--app-bg)]'
                                : 'text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]'
                        }`}
                    >
                        {pad(value)}
                    </button>
                )
            })}
        </div>
    )
}

/** Inline hour and minute columns. `value` / `onChange` speak "HH:MM". */
export function TimeColumns(props: {
    value: string
    onChange: (value: string) => void
    hourLabel: string
    minuteLabel: string
    /** Called after a minute is picked — a natural "done" for a popover. */
    onMinutePicked?: () => void
    /** Fill the container's width instead of two narrow columns. */
    stretch?: boolean
}) {
    const { hour, minute } = parseTime(props.value)
    return (
        <div className={`flex divide-x divide-[var(--app-divider)] ${props.stretch ? 'w-full' : ''}`}>
            <Column values={HOURS} selected={hour} label={props.hourLabel} stretch={props.stretch} onPick={(h) => props.onChange(formatTime(h, minute))} />
            <Column
                stretch={props.stretch}
                values={MINUTES}
                selected={minute}
                label={props.minuteLabel}
                onPick={(m) => {
                    props.onChange(formatTime(hour, m))
                    props.onMinutePicked?.()
                }}
            />
        </div>
    )
}

/** A trigger showing "HH:MM" that opens `TimeColumns` in a popover. */
export function TimePickerField(props: {
    value: string
    onChange: (value: string) => void
    ariaLabel: string
    hourLabel: string
    minuteLabel: string
    className?: string
}) {
    const [open, setOpen] = useState(false)
    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    aria-label={props.ariaLabel}
                    className={props.className ?? 'rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs tabular-nums text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}
                >
                    {props.value}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    collisionPadding={8}
                    className="z-[60] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg"
                >
                    <TimeColumns
                        value={props.value}
                        onChange={props.onChange}
                        hourLabel={props.hourLabel}
                        minuteLabel={props.minuteLabel}
                        onMinutePicked={() => setOpen(false)}
                    />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
