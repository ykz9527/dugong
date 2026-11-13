import { useEffect, useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { getAppearanceOptions, useAppearance } from '@/hooks/useTheme'
import { getColorThemeOptions, getColorThemePreview, useColorTheme, type ColorThemePreset } from '@/hooks/useColorTheme'
import { getFontScaleOptions, useFontScale } from '@/hooks/useFontScale'
import { getTerminalFontSizeOptions, useTerminalFontSize } from '@/hooks/useTerminalFontSize'
import { getSessionListStatusModeOptions, useSessionListStatusMode } from '@/hooks/useSessionListStatusMode'
import { useShowActiveSessionsOnly } from '@/hooks/useShowActiveSessionsOnly'
import { usePinInProgressSessions } from '@/hooks/usePinInProgressSessions'
import { MAX_SESSION_PREVIEW_LIMIT, MIN_SESSION_PREVIEW_LIMIT, normalizeSessionPreviewLimit, useSessionPreviewLimit } from '@/hooks/useSessionPreviewLimit'
import { useThemeColors, type ThemeColorKeyId } from '@/hooks/useThemeColors'
import { useSessionHeaderMetadata, type SessionHeaderMetadataKey } from '@/hooks/useSessionHeaderMetadata'
import { SettingsChoiceGroup, SettingsFieldLabel, SettingsPageContent, SettingsRow, SettingsSection, SettingsSwitch, settingsColorInputClass, settingsRowClass, settingsSwatchClass } from '@/components/settings/SettingsPrimitives'

function MinusIcon() {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path d="M5 12h14" /></svg>
}

function PlusIcon() {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
}

function ColorThemePicker() {
    const { t } = useTranslation()
    const { colorTheme, setColorTheme } = useColorTheme()

    return (
        <div className={`space-y-4 ${settingsRowClass}`}>
            <SettingsFieldLabel>{t('settings.display.colorTheme')}</SettingsFieldLabel>
            <div role="radiogroup" aria-label={t('settings.display.colorTheme')} className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                {getColorThemeOptions().map((option) => (
                    <ColorThemeOption
                        key={option.value}
                        theme={option.value}
                        label={t(option.labelKey)}
                        selected={colorTheme === option.value}
                        onSelect={setColorTheme}
                    />
                ))}
            </div>
        </div>
    )
}

function ColorThemeOption(props: { theme: ColorThemePreset; label: string; selected: boolean; onSelect: (theme: ColorThemePreset) => void }) {
    const preview = getColorThemePreview(props.theme)
    return (
        <label className="group flex min-w-0 cursor-pointer items-center gap-3 text-left has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--app-accent)]">
            <input type="radio" name="color-theme" value={props.theme} checked={props.selected} onChange={() => props.onSelect(props.theme)} className="sr-only" />
            <span className={settingsSwatchClass(props.selected)} style={{ backgroundColor: preview.light }} aria-hidden="true">
                <span className="absolute inset-y-0 right-0 w-1/2" style={{ backgroundColor: preview.dark }} />
                <span className="absolute inset-x-1 bottom-1 h-[3px]" style={{ backgroundColor: preview.accent }} />
            </span>
            <span className={`min-w-0 truncate text-[15px] ${props.selected ? 'font-medium text-[var(--app-fg)]' : 'text-[var(--app-fg)]'}`}>{props.label}</span>
        </label>
    )
}

function SessionPreviewLimitControl() {
    const { t } = useTranslation()
    const { sessionPreviewLimit, setSessionPreviewLimit } = useSessionPreviewLimit()
    const [draft, setDraft] = useState(String(sessionPreviewLimit))

    useEffect(() => setDraft(String(sessionPreviewLimit)), [sessionPreviewLimit])

    const commit = () => {
        const parsed = draft.trim() === '' ? sessionPreviewLimit : Number(draft)
        const next = normalizeSessionPreviewLimit(parsed)
        setSessionPreviewLimit(next)
        setDraft(String(next))
    }
    const step = (delta: number) => setSessionPreviewLimit(normalizeSessionPreviewLimit(sessionPreviewLimit + delta))
    const stepClass = 'pw-ghost-sweep flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] text-[var(--app-fg)] disabled:pointer-events-none disabled:opacity-35'

    return (
        <SettingsRow label={t('settings.display.sessionPreviewLimit')} trailing={
            <div className="flex items-center gap-2">
                <button type="button" onClick={() => step(-1)} disabled={sessionPreviewLimit <= MIN_SESSION_PREVIEW_LIMIT} aria-label={t('settings.display.sessionPreviewLimit.decrease')} className={stepClass}><MinusIcon /></button>
                <input
                    aria-label={t('settings.display.sessionPreviewLimit')}
                    type="number"
                    inputMode="numeric"
                    min={MIN_SESSION_PREVIEW_LIMIT}
                    max={MAX_SESSION_PREVIEW_LIMIT}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') { commit(); event.currentTarget.blur() }
                        if (event.key === 'Escape') { setDraft(String(sessionPreviewLimit)); event.currentTarget.blur() }
                    }}
                    className={`w-12 border-0 border-b border-[var(--app-rule)] bg-transparent py-1 text-center text-[15px] tabular-nums text-[var(--app-fg)] outline-none transition-colors duration-300 focus:border-[var(--app-accent)] focus-visible:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
                />
                <button type="button" onClick={() => step(1)} disabled={sessionPreviewLimit >= MAX_SESSION_PREVIEW_LIMIT} aria-label={t('settings.display.sessionPreviewLimit.increase')} className={stepClass}><PlusIcon /></button>
            </div>
        } />
    )
}

function ThemeColorControls() {
    const { t } = useTranslation()
    const { keys, getPickerValue, isCustomized, hasAnyCustom, setColor, resetColor, resetAll } = useThemeColors()
    return (
        <details open={hasAnyCustom} className={`group ${settingsRowClass}`}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">
                    <span className="block text-[15px] text-[var(--app-fg)]">{t('settings.display.themeColors.title')}</span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-[var(--app-hint)]">{t('settings.display.themeColors.description')}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 text-[13px] text-[var(--app-hint)]">
                    {hasAnyCustom ? t('settings.voice.advanced.customizedBadge') : t('settings.display.themeColors.expand')}
                    <span className="pw-plus text-[var(--app-fg)]" aria-hidden="true" />
                </span>
            </summary>
            <div className="pt-3">
                {hasAnyCustom ? <div className="mb-1 text-right"><button type="button" onClick={resetAll} className="pw-underline text-[13px] text-[var(--app-fg)]">{t('settings.display.themeColors.resetAll')}</button></div> : null}
                <div className="grid sm:grid-cols-2 sm:gap-x-8">
                    {keys.map((key) => (
                        <div key={key.id} className="flex min-h-11 items-center justify-between gap-3 border-t border-[var(--app-border)] py-2 first:border-t-0 sm:[&:nth-child(2)]:border-t-0">
                            <span className="min-w-0 truncate text-[15px] text-[var(--app-fg)]">{t(key.labelKey)}</span>
                            <span className="flex shrink-0 items-center gap-3">
                                {isCustomized(key.id) ? <button type="button" onClick={(event) => { event.preventDefault(); resetColor(key.id as ThemeColorKeyId) }} className="pw-underline text-[13px] text-[var(--app-hint)] hover:text-[var(--app-fg)]">{t('settings.display.themeColors.reset')}</button> : null}
                                <input type="color" aria-label={t(key.labelKey)} value={getPickerValue(key.id)} onChange={(event) => setColor(key.id as ThemeColorKeyId, event.target.value)} className={settingsColorInputClass} />
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </details>
    )
}

export default function SettingsDisplayPage() {
    const { t } = useTranslation()
    const { appearance, setAppearance } = useAppearance()
    const { fontScale, setFontScale } = useFontScale()
    const { terminalFontSize, setTerminalFontSize } = useTerminalFontSize()
    const { sessionListStatusMode, setSessionListStatusMode } = useSessionListStatusMode()
    const { showActiveSessionsOnly, setShowActiveSessionsOnly } = useShowActiveSessionsOnly()
    const { pinInProgressSessions, setPinInProgressSessions } = usePinInProgressSessions()
    const { preferences: sessionHeaderMetadata, setPreference: setSessionHeaderMetadata } = useSessionHeaderMetadata()
    const sessionHeaderOptions: ReadonlyArray<{ key: SessionHeaderMetadataKey; labelKey: string }> = [
        { key: 'showLabels', labelKey: 'settings.display.sessionHeader.showLabels' },
        { key: 'agent', labelKey: 'settings.display.sessionHeader.agent' },
        { key: 'machine', labelKey: 'settings.display.sessionHeader.machine' },
        { key: 'lastActive', labelKey: 'settings.display.sessionHeader.lastActive' },
        { key: 'model', labelKey: 'settings.display.sessionHeader.model' },
        { key: 'reasoning', labelKey: 'settings.display.sessionHeader.reasoning' },
        { key: 'fastMode', labelKey: 'settings.display.sessionHeader.fastMode' },
        { key: 'createdAt', labelKey: 'settings.display.sessionHeader.createdAt' },
        { key: 'updatedAt', labelKey: 'settings.display.sessionHeader.updatedAt' },
        { key: 'worktree', labelKey: 'settings.display.sessionHeader.worktree' },
    ]

    return (
        <SettingsPageContent>
            <SettingsSection title={t('settings.display.appearance')}>
                <SettingsChoiceGroup
                    label={t('settings.display.appearanceMode')}
                    value={appearance}
                    options={getAppearanceOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setAppearance}
                />
                <ColorThemePicker />
                <ThemeColorControls />
            </SettingsSection>

            <SettingsSection title={t('settings.display.typography')}>
                <SettingsChoiceGroup label={t('settings.display.fontSize')} value={fontScale} options={getFontScaleOptions()} onChange={setFontScale} />
                <SettingsChoiceGroup label={t('settings.display.terminalFontSize')} value={terminalFontSize} options={getTerminalFontSizeOptions()} onChange={setTerminalFontSize} />
            </SettingsSection>

            <SettingsSection title={t('settings.display.sessions')}>
                <SessionPreviewLimitControl />
                <SettingsSwitch label={t('settings.display.activeSessionsOnly')} description={t('settings.display.activeSessionsOnly.desc')} checked={showActiveSessionsOnly} onChange={setShowActiveSessionsOnly} />
                <SettingsSwitch label={t('settings.display.pinInProgressSessions')} description={t('settings.display.pinInProgressSessions.desc')} checked={pinInProgressSessions} onChange={setPinInProgressSessions} />
                <SettingsChoiceGroup
                    label={t('settings.display.sessionListStatus')}
                    description={t('settings.display.sessionListStatus.detailedDescription')}
                    value={sessionListStatusMode}
                    options={getSessionListStatusModeOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setSessionListStatusMode}
                />
            </SettingsSection>

            <SettingsSection title={t('settings.display.sessionHeader')} description={t('settings.display.sessionHeader.description')}>
                {sessionHeaderOptions.map((option) => (
                    <SettingsSwitch
                        key={option.key}
                        label={t(option.labelKey)}
                        checked={sessionHeaderMetadata[option.key]}
                        onChange={(checked) => setSessionHeaderMetadata(option.key, checked)}
                    />
                ))}
            </SettingsSection>
        </SettingsPageContent>
    )
}
