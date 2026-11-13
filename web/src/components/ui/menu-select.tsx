import { useEffect, useMemo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'

/**
 * A dropdown in the app's own style.
 *
 * `<select>` opens the platform's native list — fine for forms, jarring inside
 * the app's popovers and panels, and unusable for a list as long as the IANA
 * time zones. This one renders its list in a popover and can filter it.
 */

export type MenuOption<T extends string | number> = { value: T; label: string }

export function MenuSelect<T extends string | number>(props: {
    value: T
    options: readonly MenuOption<T>[]
    onChange: (value: T) => void
    ariaLabel: string
    /** Show a filter box above the list (long lists). */
    searchPlaceholder?: string
    className?: string
}) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const listRef = useRef<HTMLDivElement>(null)
    const current = props.options.find((option) => option.value === props.value)

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (!needle) return props.options
        return props.options.filter((option) => option.label.toLowerCase().includes(needle))
    }, [props.options, query])

    useEffect(() => {
        if (!open) {
            setQuery('')
            return
        }
        const frame = requestAnimationFrame(() => {
            listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'center' })
        })
        return () => cancelAnimationFrame(frame)
    }, [open])

    const pick = (value: T) => {
        props.onChange(value)
        setOpen(false)
    }

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    aria-label={props.ariaLabel}
                    aria-haspopup="listbox"
                    className={`inline-flex min-w-0 items-center justify-between gap-1.5 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] ${props.className ?? ''}`}
                >
                    <span className="truncate">{current?.label ?? String(props.value)}</span>
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m6 9 6 6 6-6" />
                    </svg>
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    collisionPadding={8}
                    className="z-[60] flex max-h-72 w-[var(--radix-popover-trigger-width)] min-w-40 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg"
                >
                    {props.searchPlaceholder ? (
                        <input
                            type="text"
                            autoFocus
                            value={query}
                            placeholder={props.searchPlaceholder}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                const first = filtered[0]
                                if (event.key === 'Enter' && first) {
                                    event.preventDefault()
                                    pick(first.value)
                                }
                            }}
                            className="m-1.5 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                        />
                    ) : null}
                    <div ref={listRef} role="listbox" aria-label={props.ariaLabel} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
                        {filtered.map((option) => {
                            const selected = option.value === props.value
                            return (
                                <button
                                    key={String(option.value)}
                                    type="button"
                                    role="option"
                                    aria-selected={selected}
                                    data-selected={selected}
                                    onClick={() => pick(option.value)}
                                    className={`block w-full truncate px-2.5 py-1 text-left text-xs ${
                                        selected
                                            ? 'bg-[var(--app-secondary-bg)] font-medium text-[var(--app-link)]'
                                            : 'text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]'
                                    }`}
                                >
                                    {option.label}
                                </button>
                            )
                        })}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
