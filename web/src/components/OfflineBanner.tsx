import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useTranslation } from '@/lib/use-translation'

export function OfflineBanner({
    isHubConnected,
    isReconnecting
}: {
    isHubConnected: boolean
    isReconnecting: boolean
}) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()

    if (isOnline || isHubConnected || isReconnecting) {
        return null
    }

    return (
        <div className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--app-rule)] bg-[var(--app-banner-bg)] pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-center text-[13px] font-medium leading-5 text-[var(--app-banner-text)]">
            {t('offline.message')}
        </div>
    )
}
