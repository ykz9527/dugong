import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { usePlatform } from '@/hooks/usePlatform'
import { usePwaUpdateContext } from '@/lib/pwa-update-context'
import { useTranslation } from '@/lib/use-translation'
import { useVoiceOptional } from '@/lib/voice-context'

export function PwaUpdateBanner({ topClassName }: { topClassName?: string } = {}) {
    const { t } = useTranslation()
    const { needRefresh, reload } = usePwaUpdateContext()
    const isOnline = useOnlineStatus()
    const { haptic } = usePlatform()

    if (!needRefresh) {
        return null
    }

    const topClass = topClassName ?? (isOnline
        ? 'top-[calc(env(safe-area-inset-top)+0.5rem)]'
        : 'top-[calc(env(safe-area-inset-top)+2.5rem)]')

    return (
        <div
            data-testid="pwa-update-banner"
            className={`fixed left-4 right-4 z-50 border border-[var(--app-rule)] bg-[var(--app-bg)] px-4 py-3 ${topClass}`}
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--app-fg)]">
                        {t('pwa.update.title')}
                    </p>
                    <p className="mt-0.5 text-[13px] text-[var(--app-hint)]">
                        {t('pwa.update.body')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => {
                        haptic.impact('light')
                        reload()
                    }}
                    className="pw-sweep h-8 shrink-0 rounded-full bg-[var(--app-button)] px-3.5 text-[13px] font-semibold text-[var(--app-button-text)]"
                >
                    {t('pwa.update.reload')}
                </button>
            </div>

            <details className="mt-3 border-t border-[var(--app-border)] pt-2">
                <summary className="cursor-pointer list-none text-xs font-semibold text-[var(--app-fg)] [&::-webkit-details-marker]:hidden">
                    <span className="pw-underline">{t('pwa.update.whyToggle')}</span>
                </summary>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--app-hint)]">
                    {t('pwa.update.whyBody')}
                </p>
            </details>
        </div>
    )
}

export function PwaUpdateBannerWithStatusOffset({
    isSyncing,
    isReconnecting,
}: {
    isSyncing: boolean
    isReconnecting: boolean
}) {
    const voice = useVoiceOptional()
    const hasTopStatusBanner =
        isSyncing ||
        isReconnecting ||
        Boolean(voice && voice.status === 'error' && voice.errorMessage)

    return (
        <PwaUpdateBanner
            topClassName={hasTopStatusBanner
                ? 'top-[calc(env(safe-area-inset-top)+3rem)]'
                : undefined}
        />
    )
}
