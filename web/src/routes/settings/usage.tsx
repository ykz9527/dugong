import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageSummaryBucket } from '@hapi/protocol/apiTypes'
import { SettingsPageContent, SettingsRow, SettingsSection, settingsPillClass, settingsRowClass } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

type UsageRange = '7d' | '30d' | 'all'

function formatTokens(value: number): string {
    if (value < 1000) return value.toLocaleString()
    if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
    if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
    return `${(value / 1_000_000_000).toFixed(1)}B`
}

function UsageBarList(props: { rows: UsageSummaryBucket[]; empty: string }) {
    const { t } = useTranslation()
    const max = props.rows[0]?.totalTokens ?? 0
    if (props.rows.length === 0) return <div className={`text-[15px] text-[var(--app-hint)] ${settingsRowClass}`}>{props.empty}</div>
    return (
        <div>
            {props.rows.slice(0, 8).map((row, index) => (
                <div key={row.key} style={{ ['--i' as string]: index }} className={settingsRowClass}>
                    <div className="flex items-center justify-between gap-3 text-[15px]">
                        <span className="min-w-0 truncate text-[var(--app-fg)]">{row.key}</span>
                        <span className="shrink-0 tabular-nums text-[var(--app-fg)]">{formatTokens(row.totalTokens)}</span>
                    </div>
                    <div className="mt-2 h-1 overflow-hidden bg-[var(--app-subtle-bg)]">
                        <div className="h-full bg-[var(--app-fg)]" style={{ width: `${max > 0 ? Math.max(2, (row.totalTokens / max) * 100) : 0}%` }} />
                    </div>
                    <div className="mt-1.5 text-[13px] text-[var(--app-hint)]">
                        {t('settings.usage.bucketDetails', {
                            requests: row.requests.toLocaleString(),
                            input: formatTokens(row.inputTokens),
                            output: formatTokens(row.outputTokens)
                        })}
                    </div>
                </div>
            ))}
        </div>
    )
}

export default function SettingsUsagePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const [range, setRange] = useState<UsageRange>('7d')
    const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    const query = useQuery({
        queryKey: queryKeys.usageSummary(range, timeZone),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getUsageSummary(range, timeZone)
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: false
    })
    const maxDaily = useMemo(() => Math.max(...(query.data?.daily.map((row) => row.totalTokens) ?? [0]), 1), [query.data?.daily])
    const cacheHitRate = query.data && query.data.totals.inputTokens > 0
        ? `${((query.data.totals.cacheReadTokens / query.data.totals.inputTokens) * 100).toFixed(1)}%`
        : '0%'

    return (
        <SettingsPageContent>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('settings.usage.range.label')}>
                {(['7d', '30d', 'all'] as const).map((option) => (
                    <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={range === option}
                        onClick={() => setRange(option)}
                        className={settingsPillClass(range === option)}
                    >
                        {t(`settings.usage.range.${option}`)}
                    </button>
                ))}
            </div>

            {query.isLoading ? <SettingsSection><SettingsRow label={t('settings.usage.loading')} /></SettingsSection> : null}
            {query.error ? <SettingsSection><SettingsRow label={t('settings.usage.error')} description={query.error instanceof Error ? query.error.message : undefined} /></SettingsSection> : null}
            {query.data ? (
                <>
                    <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
                        {[
                            ['settings.usage.total', query.data.totals.totalTokens],
                            ['settings.usage.uncached', query.data.totals.uncachedTokens],
                            ['settings.usage.input', query.data.totals.inputTokens],
                            ['settings.usage.output', query.data.totals.outputTokens],
                            ['settings.usage.cacheRead', query.data.totals.cacheReadTokens],
                            ['settings.usage.cacheCreation', query.data.totals.cacheCreationTokens],
                            ['settings.usage.cacheHitRate', cacheHitRate],
                            ['settings.usage.requests', query.data.totals.requests]
                        ].map(([label, value], index) => (
                            <div key={label} style={{ ['--i' as string]: index }} className="pw-ledger flex flex-col py-3">
                                <div className="pw-eyebrow text-[var(--app-hint)]">{t(label as string)}</div>
                                <div className="pw-title mt-auto pt-1.5 tabular-nums text-[var(--app-fg)]">{typeof value === 'number' ? formatTokens(value) : value}</div>
                            </div>
                        ))}
                    </div>
                    <SettingsSection title={t('settings.usage.daily.title')}>
                        {query.data.daily.length === 0 ? <div className={`text-[15px] text-[var(--app-hint)] ${settingsRowClass}`}>{t('settings.usage.empty')}</div> : (
                            <div className="pw-ledger space-y-2.5 py-4">
                                {query.data.daily.map((row) => (
                                    <div key={row.key} className="grid grid-cols-[5.5rem_1fr_3.5rem] items-center gap-3 text-[13px]">
                                        <span className="tabular-nums text-[var(--app-hint)]">{row.key}</span>
                                        <div className="h-2 overflow-hidden bg-[var(--app-subtle-bg)]"><div className="h-full bg-[var(--app-fg)]" style={{ width: `${Math.max(2, (row.totalTokens / maxDaily) * 100)}%` }} /></div>
                                        <span className="text-right tabular-nums text-[var(--app-fg)]">{formatTokens(row.totalTokens)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </SettingsSection>
                    <div className="grid gap-9 md:grid-cols-2 md:gap-8">
                        <SettingsSection title={t('settings.usage.agent.title')}>
                            <UsageBarList rows={query.data.byAgent} empty={t('settings.usage.empty')} />
                        </SettingsSection>
                        <SettingsSection title={t('settings.usage.model.title')}>
                            <UsageBarList rows={query.data.byModel} empty={t('settings.usage.empty')} />
                        </SettingsSection>
                    </div>
                    <div className="space-y-1 text-[13px] leading-snug text-[var(--app-hint)]">
                        <p>{t('settings.usage.sessions', { count: query.data.totals.sessions })}</p>
                        <p>{t('settings.usage.description')}</p>
                    </div>
                </>
            ) : null}
        </SettingsPageContent>
    )
}
