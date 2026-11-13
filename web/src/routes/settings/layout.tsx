import { useRef } from 'react'
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { usePageEnter } from '@/lib/use-page-enter'
import { useTranslation } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { SettingsNav } from '@/components/settings/SettingsNav'
import { getSettingsCategory } from './categories'

function BackIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
        </svg>
    )
}

export default function SettingsLayout() {
    const { t } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const pathname = useLocation({ select: (location) => location.pathname })
    const category = getSettingsCategory(pathname)
    const mainRef = useRef<HTMLElement>(null)
    usePageEnter(mainRef, pathname)
    const mobileTitleKey = pathname === '/settings/voice/voices'
        ? 'settings.voice.voice'
        : pathname === '/settings/voice/advanced'
            ? 'settings.voice.advanced.title'
            : category?.titleKey ?? 'settings.title'
    const mobileTitle = t(mobileTitleKey)
    // Desktop shows Display at /settings, so its page title follows the nav.
    const pageTitle = t(category || pathname !== '/settings' ? mobileTitleKey : 'settings.display.title')

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="shrink-0 border-b border-[var(--app-rule)] bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 p-3">
                    <button type="button" onClick={goBack} aria-label={t('common.back')} className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors duration-300 hover:text-[var(--app-fg)] lg:hidden">
                        <BackIcon />
                    </button>
                    <button type="button" onClick={() => navigate({ to: '/sessions' })} aria-label={t('common.back')} className="hidden h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors duration-300 hover:text-[var(--app-fg)] lg:flex">
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <h1 className="truncate text-[17px] font-medium tracking-[-0.02em] lg:hidden">{mobileTitle}</h1>
                        <h1 className="hidden text-[17px] font-medium tracking-[-0.02em] lg:block">{t('settings.title')}</h1>
                    </div>
                </div>
            </header>

            <div className="min-h-0 flex-1">
                <div className="mx-auto flex h-full w-full max-w-content min-h-0">
                    <aside className="hidden w-56 shrink-0 border-r border-[var(--app-rule)] lg:block">
                        <SettingsNav activeId={category?.id ?? 'display'} />
                    </aside>
                    <main ref={mainRef} className="app-scroll-y min-w-0 flex-1 lg:[scrollbar-gutter:stable_both-edges]">
                        <div className="mx-auto hidden w-full max-w-[720px] px-8 pb-6 pt-8 lg:block">
                            <h2 className="pw-title text-[var(--app-fg)]">{pageTitle}</h2>
                        </div>
                        <Outlet />
                    </main>
                </div>
            </div>
        </div>
    )
}
