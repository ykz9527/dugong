import { PROTOCOL_VERSION } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'

export default function SettingsAboutPage() {
    const { t } = useTranslation()
    return (
        <SettingsPageContent>
            <SettingsSection>
                <SettingsRow label={t('settings.about.website')} trailing={
                    <a href="https://github.com/ykz9527/dugong" target="_blank" rel="noopener noreferrer" className="pw-underline text-[var(--app-fg)]">github.com/ykz9527/dugong</a>
                } />
                <SettingsRow label={t('settings.about.appVersion')} trailing={<span className="tabular-nums text-[var(--app-hint)]">{__APP_VERSION__}</span>} />
                <SettingsRow label={t('settings.about.protocolVersion')} trailing={<span className="tabular-nums text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>} />
            </SettingsSection>
        </SettingsPageContent>
    )
}
