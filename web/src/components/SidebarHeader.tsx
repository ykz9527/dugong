import type { ReactNode } from 'react'
import { useTranslation } from '@/lib/use-translation'

/**
 * Title row of the sidebar: the task list's name, how many cards wait on a
 * human, and the sidebar's actions.
 *
 * There used to be a Sessions / Tasks switch here. Every conversation now
 * belongs to a card, so there is only one list to show.
 */
export function SidebarHeader(props: {
    /** Cards waiting on a human, so the count is visible at a glance. */
    attentionCount: number
    actions?: ReactNode
}) {
    const { t } = useTranslation()

    return (
        <div className="flex items-center gap-2 px-3 pb-1 pt-3">
            <DugongMark />
            {/* One line whatever the sidebar width: the actions give way first.
                No negative tracking — it crowds CJK titles. */}
            <span className="shrink-0 whitespace-nowrap text-2xl font-medium leading-none text-[var(--app-fg)]">{t('sidebar.title')}</span>
            {props.attentionCount > 0 ? (
                <span
                    key={props.attentionCount}
                    className="pw-bump shrink-0 self-start text-xs font-semibold tabular-nums text-[var(--app-accent)]"
                    title={t('sidebar.tasks.attention', { count: props.attentionCount })}
                >
                    {props.attentionCount}
                </span>
            ) : null}
            <div className="flex-1" />
            {props.actions}
        </div>
    )
}

const DUGONG_BODY = 'M 10 68 C 8 58, 14 50, 24 46 C 36 41, 54 38, 70 40 C 84 42, 96 48, 104 54 C 110 50, 117 46, 125 45 C 121 51, 117 56, 113 60 C 117 64, 121 69, 125 76 C 117 74, 110 70, 104 66 C 94 78, 78 87, 58 88 C 44 89, 34 87, 28 83 C 26 89, 20 93, 14 92 C 8 90, 7 80, 10 68 Z'
const DUGONG_FLIPPER = 'M 44 85 C 46 93, 50 99, 58 102 C 59 95, 56 89, 52 85 Z'

/**
 * dugong's mark, the same as `public/icon.svg` but in the theme's colours: a
 * disc with a dugong carrying a three-row task list, the middle row red.
 */
export function DugongMark() {
    const fg = { fill: 'var(--app-fg)' }
    const bg = { fill: 'var(--app-bg)' }
    return (
        <svg aria-hidden="true" viewBox="0 0 128 128" className="h-8 w-8 shrink-0">
            <circle cx="64" cy="64" r="64" style={fg} />
            <g transform="translate(64 64) scale(0.8) translate(-67 -71)">
                <path d={DUGONG_BODY} style={bg} />
                <path d={DUGONG_FLIPPER} style={bg} />
                <circle cx="23" cy="58" r="2.8" style={fg} />
                <rect x="40" y="52" width="48" height="8" rx="4" style={fg} />
                <rect x="40" y="64" width="36" height="8" rx="4" style={{ fill: 'var(--app-accent)' }} />
                <rect x="40" y="76" width="24" height="8" rx="4" style={fg} />
            </g>
        </svg>
    )
}
