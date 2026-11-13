import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

export function SyncingBanner({ isSyncing }: { isSyncing: boolean }) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()

    // Don't show syncing banner when offline (OfflineBanner takes precedence)
    if (!isSyncing || !isOnline) {
        return null
    }

    return (
        <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 border-b border-[var(--app-rule)] bg-[var(--app-subtle-bg)] pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-center text-[13px] font-medium leading-5 text-[var(--app-fg)]">
            <Spinner size="sm" label={null} className="text-[var(--app-fg)]" />
            {t('syncing.title')}
        </div>
    )
}
