import type { ReactNode } from 'react'

/*
 * Settings as a ledger (DESIGN.md §6): every setting is a row on a 1px
 * hairline, 15px label left with a 13px grey hint under it, control right.
 * Sections have a grey eyebrow and no box.
 */

/** Row chrome shared by every ledger row in a settings section. */
export const settingsRowClass = 'pw-ledger py-3'

/** Underline field (template `.m-field`): no box, 1px bottom rule. */
export const settingsFieldClass = 'w-full border-0 border-b border-[var(--app-rule)] bg-transparent px-0 py-1.5 text-[15px] text-[var(--app-fg)] outline-none transition-colors duration-300 placeholder:text-[var(--app-hint)] focus:border-[var(--app-accent)] focus-visible:outline-none disabled:opacity-50'

/** Underline select, used with `SelectControl`. */
export const settingsSelectClass = 'border-0 border-b border-[var(--app-rule)] bg-transparent py-1.5 pl-0 text-[15px] text-[var(--app-fg)] outline-none transition-colors duration-300 focus:border-[var(--app-accent)] focus-visible:outline-none'

/** 12px/600 grey label above a field. */
export const settingsFieldLabelClass = 'pw-eyebrow text-[var(--app-hint)]'

/** Choice pill: selected black, others hairline outline. */
export function settingsPillClass(selected: boolean): string {
    return `min-w-0 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-300 ease-[var(--ease)] ${selected
        ? 'border-[var(--app-button)] bg-[var(--app-button)] text-[var(--app-button-text)]'
        : 'border-[var(--app-border)] text-[var(--app-fg)] hover:border-[var(--app-fg)]'}`
}

/** Square swatch with a 1px frame; the selected one gets a 2px black frame. */
export function settingsSwatchClass(selected: boolean): string {
    return `relative h-7 w-7 shrink-0 overflow-hidden outline-solid transition-[outline-color,outline-width] duration-300 ease-[var(--ease)] ${selected
        ? 'outline-2 outline-[var(--app-fg)]'
        : 'outline-1 outline-[var(--app-border)] group-hover:outline-[var(--app-fg)]'}`
}

/** Native colour input drawn as a square swatch with a hairline frame. */
export const settingsColorInputClass = 'h-7 w-9 shrink-0 cursor-pointer appearance-none border border-[var(--app-border)] bg-transparent p-0 [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0'

export function SettingsFieldLabel(props: { children: ReactNode; hidden?: boolean; description?: string; className?: string }) {
    if (props.hidden) return null
    if (!props.description) return <div className={`text-[15px] text-[var(--app-fg)] ${props.className ?? ''}`}>{props.children}</div>
    return (
        <div className={props.className}>
            <div className="text-[15px] text-[var(--app-fg)]">{props.children}</div>
            <div className="mt-0.5 text-[13px] leading-snug text-[var(--app-hint)]">{props.description}</div>
        </div>
    )
}

export function ArrowRightIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={props.className} aria-hidden="true">
            <path d="M4 12h16M14 6l6 6-6 6" />
        </svg>
    )
}

export function CheckIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={props.className} aria-hidden="true">
            <path d="m20 6-11 11-5-5" />
        </svg>
    )
}

export function SettingsPageContent(props: { children: ReactNode }) {
    return (
        <div className="mx-auto w-full max-w-[720px] space-y-9 px-4 pb-10 pt-4 lg:px-8 lg:pt-2">
            {props.children}
        </div>
    )
}

export function SettingsSection(props: { title?: string; description?: string; children: ReactNode }) {
    return (
        <section className="pw-section">
            {props.title ? <h2 className="pw-eyebrow mb-2">{props.title}</h2> : null}
            {props.description ? <p className="mb-3 max-w-[60ch] text-[13px] leading-snug text-[var(--app-hint)]">{props.description}</p> : null}
            <div className="border-b border-[var(--app-border)]">
                {props.children}
            </div>
        </section>
    )
}

export function SettingsRow(props: { label: string; description?: string; trailing?: ReactNode; children?: ReactNode }) {
    return (
        <div className={`flex min-h-12 items-center justify-between gap-4 ${settingsRowClass}`}>
            <div className="min-w-0">
                <div className="text-[15px] text-[var(--app-fg)]">{props.label}</div>
                {props.description ? <div className="mt-0.5 text-[13px] leading-snug text-[var(--app-hint)]">{props.description}</div> : null}
                {props.children}
            </div>
            {props.trailing ? <div className="shrink-0 text-[15px]">{props.trailing}</div> : null}
        </div>
    )
}

/** Pill track switch: grey off, black on, thumb glides with `--ease`. */
export function SwitchControl(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <span className="relative inline-flex h-6 w-10 shrink-0 items-center">
            <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} className="peer sr-only" aria-label={props.label} />
            <span className="absolute inset-0 rounded-full bg-[var(--app-border)] transition-colors duration-300 ease-[var(--ease)] peer-checked:bg-[var(--app-fg)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--app-accent)]" />
            <span className="absolute left-[3px] h-[18px] w-[18px] rounded-full bg-[var(--app-bg)] transition-transform duration-[450ms] ease-[var(--ease)] peer-checked:translate-x-4" />
        </span>
    )
}

export function SettingsSwitch(props: { label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <label className={`flex min-h-12 cursor-pointer items-center justify-between gap-4 ${settingsRowClass}`}>
            <span className="min-w-0">
                <span className="block text-[15px] text-[var(--app-fg)]">{props.label}</span>
                {props.description ? <span className="mt-0.5 block text-[13px] leading-snug text-[var(--app-hint)]">{props.description}</span> : null}
            </span>
            <SwitchControl label={props.label} checked={props.checked} onChange={props.onChange} />
        </label>
    )
}

export function SettingsChoiceGroup<T extends string | number>(props: {
    label: string
    description?: string
    hideLabel?: boolean
    /** Render without row chrome (no hairline, no padding), e.g. inside another row. */
    inset?: boolean
    value: T
    options: ReadonlyArray<{ value: T; label: string; description?: string }>
    onChange: (value: T) => void
}) {
    const described = props.options.some((option) => option.description)
    const group = described ? (
        <div role="radiogroup" aria-label={props.label} className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {props.options.map((option) => {
                const selected = props.value === option.value
                return (
                    <button
                        key={String(option.value)}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => props.onChange(option.value)}
                        className="group flex min-w-0 items-start gap-2.5 text-left"
                    >
                        <span aria-hidden="true" className={`mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-300 ${selected ? 'border-[var(--app-fg)]' : 'border-[var(--app-border)] group-hover:border-[var(--app-fg)]'}`}>
                            <span className={`h-2 w-2 rounded-full bg-[var(--app-fg)] transition-opacity duration-300 ${selected ? 'opacity-100' : 'opacity-0'}`} />
                        </span>
                        <span className="min-w-0">
                            <span className={`block text-[15px] ${selected ? 'font-medium text-[var(--app-fg)]' : 'text-[var(--app-fg)]'}`}>{option.label}</span>
                            {option.description ? <span className="mt-0.5 block text-[13px] leading-snug text-[var(--app-hint)]">{option.description}</span> : null}
                        </span>
                    </button>
                )
            })}
        </div>
    ) : (
        <div role="radiogroup" aria-label={props.label} className={`flex flex-wrap gap-2 ${props.hideLabel ? '' : 'sm:shrink-0 sm:flex-nowrap sm:justify-end'}`}>
            {props.options.map((option) => {
                const selected = props.value === option.value
                return (
                    <button
                        key={String(option.value)}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => props.onChange(option.value)}
                        className={settingsPillClass(selected)}
                    >
                        <span className="block truncate">{option.label}</span>
                    </button>
                )
            })}
        </div>
    )
    const stacked = described || props.hideLabel
    return (
        <div className={`${props.inset ? '' : settingsRowClass} ${stacked ? 'space-y-3' : 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6'}`}>
            <SettingsFieldLabel hidden={props.hideLabel} description={props.description} className={stacked ? undefined : 'min-w-0 sm:flex-1'}>{props.label}</SettingsFieldLabel>
            {group}
        </div>
    )
}

export function SettingsLinkRow(props: { label: string; value?: string; description?: string; onClick: () => void }) {
    return (
        <button type="button" onClick={props.onClick} className={`group flex min-h-12 w-full items-center gap-4 text-left ${settingsRowClass}`}>
            <span className="min-w-0 flex-1">
                <span className="block text-[15px] text-[var(--app-fg)]">{props.label}</span>
                {props.description ? <span className="mt-0.5 block text-[13px] leading-snug text-[var(--app-hint)]">{props.description}</span> : null}
            </span>
            {props.value ? <span className="max-w-[45%] truncate text-[15px] text-[var(--app-hint)]">{props.value}</span> : null}
            <ArrowRightIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)] transition-colors duration-300 group-hover:text-[var(--app-fg)]" />
        </button>
    )
}
