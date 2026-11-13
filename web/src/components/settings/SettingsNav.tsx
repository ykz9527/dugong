import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/lib/use-translation'
import { useAppearance } from '@/hooks/useTheme'
import { useFontScale } from '@/hooks/useFontScale'
import { useComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { useAppContext } from '@/lib/app-context'
import { settingsCategories } from '@/routes/settings/categories'
import { ArrowRightIcon } from './SettingsPrimitives'

const OWNER_ONLY_CATEGORIES = new Set(['storage', 'usage'])

export function getNamespaceFromToken(token: string): string | null {
    try {
        const payload = token.split('.')[1]
        if (!payload) return null
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
        const decoded = JSON.parse(atob(base64)) as { ns?: unknown }
        return typeof decoded.ns === 'string' ? decoded.ns : null
    } catch {
        return null
    }
}

export function SettingsNav(props: { activeId?: string; mobile?: boolean }) {
    const navigate = useNavigate()
    const { token } = useAppContext()
    const { t, locale } = useTranslation()
    const { appearance } = useAppearance()
    const { fontScale } = useFontScale()
    const { composerEnterBehavior } = useComposerEnterBehavior()

    const summaries: Record<string, string> = {
        general: locale === 'zh-CN' ? '简体中文' : 'English',
        display: `${t(`settings.display.appearance.${appearance}`)} · ${Math.round(fontScale * 100)}%`,
        chat: t(`settings.chat.enterBehavior.${composerEnterBehavior}`),
        voice: t('settings.hub.voice.summary'),
        machines: t('settings.hub.machines.summary'),
        storage: t('settings.storage.summary'),
        usage: t('settings.usage.summary'),
        about: `v${__APP_VERSION__}`,
    }
    const visibleCategories = settingsCategories.filter((category) => !OWNER_ONLY_CATEGORIES.has(category.id) || getNamespaceFromToken(token) === 'default')

    return (
        <nav aria-label={t('settings.title')} className={props.mobile ? 'border-b border-[var(--app-border)]' : 'flex flex-col gap-0.5 py-6 pl-4 pr-4 lg:pl-6'}>
            {visibleCategories.map((category, index) => {
                const active = props.activeId === category.id
                return (
                    <button
                        key={category.id}
                        type="button"
                        onClick={() => navigate({ to: category.path })}
                        aria-current={active ? 'page' : undefined}
                        style={props.mobile ? { ['--i' as string]: index } : undefined}
                        className={props.mobile
                            ? 'pw-ledger group flex min-h-14 w-full items-center gap-4 py-3 text-left'
                            : `flex w-full items-center px-3 py-2 text-left text-[15px] transition-colors duration-300 ease-[var(--ease)] ${active ? 'bg-[var(--app-highlight-bg)] text-[var(--app-highlight-fg)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}
                    >
                        <span className="min-w-0 flex-1">
                            <span className={props.mobile ? 'block text-[15px] text-[var(--app-fg)]' : 'block'}>{t(category.titleKey)}</span>
                            {props.mobile ? <span className="mt-0.5 block truncate text-[13px] text-[var(--app-hint)]">{summaries[category.id]}</span> : null}
                        </span>
                        {props.mobile ? <ArrowRightIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)] transition-colors duration-300 group-hover:text-[var(--app-fg)]" /> : null}
                    </button>
                )
            })}
        </nav>
    )
}
