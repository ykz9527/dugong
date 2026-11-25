import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { ComposerToolbarLayout } from '@/hooks/useComposerToolbarLayout'
import { HappyComposer } from './HappyComposer'

/**
 * Focused harness for the session settings sheet (the gear is its only entry).
 * Reuses the assistant-ui mock strategy from HappyComposer.sendError.test.tsx
 * but keeps ComposerButtons unmocked so the toolbar is exercised for real.
 */
type FakeAttachment = { id: string; status: { type: 'complete' } }
type MockComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    asChild?: boolean
    maxRows?: number
    submitOnEnter?: boolean
    cancelOnEscape?: boolean
}
type FakeRuntimeState = {
    composer: { text: string; attachments: FakeAttachment[] }
    thread: { isRunning: boolean; isDisabled: boolean }
}

const runtime = vi.hoisted(() => ({
    snapshot: {
        composer: { text: '', attachments: [] as FakeAttachment[] },
        thread: { isRunning: false, isDisabled: false },
    } as FakeRuntimeState,
    setSnapshot: null as null | ((updater: (current: FakeRuntimeState) => FakeRuntimeState) => void),
    pendingSendIntentRef: { current: 'default' },
    sentIntents: [] as ComposerSendIntent[],
    narrowViewport: false,
    toolbarLayout: null as ComposerToolbarLayout | null,
    cancelRuns: 0,
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        useAui: () => ({
            composer: () => ({
                setText: (text: string) => {
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { ...current.composer, text },
                    }))
                },
                send: () => {
                    const intent = runtime.pendingSendIntentRef?.current ?? 'default'
                    runtime.sentIntents.push(intent as ComposerSendIntent)
                    if (runtime.pendingSendIntentRef) runtime.pendingSendIntentRef.current = 'default'
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { text: '', attachments: [] },
                    }))
                },
                addAttachment: async () => {},
            }),
            thread: () => ({ cancelRun: () => { runtime.cancelRuns += 1 } }),
        }),
        useAuiState: (selector: (state: typeof runtime.snapshot) => unknown) => selector(runtime.snapshot),
        ComposerPrimitive: {
            Root: ({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) => (
                <form onSubmit={onSubmit}>{children}</form>
            ),
            AddAttachment: ({ children }: { children: ReactNode }) => <>{children}</>,
            Input: React.forwardRef<HTMLTextAreaElement, MockComposerInputProps>(
                ({
                    asChild: _asChild,
                    onChange,
                    maxRows: _maxRows,
                    submitOnEnter: _submitOnEnter,
                    cancelOnEscape: _cancelOnEscape,
                    ...props
                }, ref) => (
                    <textarea
                        {...props}
                        ref={ref}
                        value={runtime.snapshot.composer.text}
                        onChange={(event) => {
                            runtime.setSnapshot!((current) => ({
                                ...current,
                                composer: { ...current.composer, text: event.target.value },
                            }))
                        }}
                    />
                ),
            ),
        },
    }
})
vi.mock('@/hooks/useComposerToolbarLayout', async () => {
    const actual = await import('@/hooks/useComposerToolbarLayout')
    return {
        ...actual,
        useComposerToolbarLayout: () => ({ layout: runtime.toolbarLayout ?? actual.DEFAULT_COMPOSER_TOOLBAR_LAYOUT }),
    }
})
vi.mock('@/hooks/useNarrowViewport', () => ({
    useNarrowViewport: () => runtime.narrowViewport,
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({ sessionId: undefined, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({ useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }) }))
vi.mock('@/hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ isStandalone: false, isIOS: false }) }))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}] }))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({ FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))

function renderComposer(agentFlavor: string, overrides: Partial<Parameters<typeof HappyComposer>[0]> = {}) {
    render(
        <I18nProvider>
            <HappyComposer
                sessionId="composer-test"
                disabled={false}
                agentFlavor={agentFlavor}
                model="claude-sonnet-4"
                effort="high"
                permissionMode="default"
                onModelChange={vi.fn()}
                onEffortChange={vi.fn()}
                onPermissionModeChange={vi.fn()}
                availableModelOptions={[{ value: 'claude-sonnet-4', label: 'Sonnet 4' }]}
                pendingSendIntentRef={runtime.pendingSendIntentRef as { current: ComposerSendIntent }}
                {...overrides}
            />
        </I18nProvider>
    )
}

const gear = () => screen.getByRole('button', { name: 'Settings' })
const choice = (name: string) => screen.getByRole('button', { name })
const isSelected = (name: string) => choice(name).getAttribute('aria-pressed') === 'true'

describe('HappyComposer session settings sheet', () => {
    afterEach(() => {
        cleanup()
        runtime.setSnapshot = null
        runtime.narrowViewport = false
        runtime.toolbarLayout = null
        runtime.snapshot.thread.isDisabled = false
        runtime.sentIntents = []
    })

    it.each([false, true])('offers only the gear in the toolbar (narrow=%s)', (narrow) => {
        runtime.narrowViewport = narrow
        renderComposer('claude')
        expect(gear()).toBeTruthy()
        // No separate model / effort / permission buttons next to the gear.
        expect(screen.queryByRole('button', { name: 'Sonnet 4' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
        expect(screen.queryByRole('button', { name: /Permissions/ })).toBeNull()
    })

    it('shows model, effort and permission together, in that order', () => {
        renderComposer('claude')
        fireEvent.click(gear())
        const model = screen.getByText('Model')
        const effort = screen.getByText('Effort')
        const permission = screen.getByText('Permission Mode')
        expect(model.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(effort.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(isSelected('Sonnet 4')).toBe(true)
        expect(isSelected('High')).toBe(true)
    })

    it('stays open after a pick so several settings change in one visit', () => {
        const onModelChange = vi.fn()
        const onEffortChange = vi.fn()
        const onPermissionModeChange = vi.fn()
        renderComposer('claude', { onModelChange, onEffortChange, onPermissionModeChange })
        fireEvent.click(gear())
        fireEvent.click(within(screen.getByRole('group', { name: 'Model' })).getByRole('button', { name: 'Default' }))
        fireEvent.click(choice('Low'))
        fireEvent.click(within(screen.getByRole('group', { name: 'Permission Mode' })).getByRole('button', { name: 'Accept Edits' }))
        expect(onModelChange).toHaveBeenCalledWith(null)
        expect(onEffortChange).toHaveBeenCalledWith('low')
        expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits')
        expect(screen.getByText('Model')).toBeTruthy()
    })

    it('closes on Escape without aborting the running turn', () => {
        runtime.snapshot.thread.isRunning = true
        renderComposer('claude')
        fireEvent.click(gear())
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
        expect(screen.queryByText('Model')).toBeNull()
        expect(runtime.cancelRuns).toBe(0)
        runtime.snapshot.thread.isRunning = false
    })

    it('closes from the gear and from a click outside', () => {
        renderComposer('claude')
        fireEvent.click(gear())
        fireEvent.click(gear())
        expect(screen.queryByText('Model')).toBeNull()
        fireEvent.click(gear())
        fireEvent.pointerDown(document.body)
        expect(screen.queryByText('Model')).toBeNull()
    })

    it('keeps the gear visible even when a saved toolbar layout hides it', () => {
        runtime.toolbarLayout = {
            mode: 'left',
            left: ['attachment', 'expand', 'terminal'],
            right: [],
            hidden: ['settings', 'abort'],
        }
        renderComposer('claude')
        expect(gear()).toBeTruthy()
    })

    it('groups Pi models by provider and marks only the selected provider', () => {
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
                { provider: 'vertex', modelId: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'vertex', modelId: 'gemini-2.5-pro' },
        })
        fireEvent.click(gear())
        expect(screen.getByText('Model')).toBeTruthy()
        expect(isSelected('Gemini 2.5 Pro')).toBe(false)
        expect(isSelected('Vertex Gemini 2.5 Pro')).toBe(true)
    })

    it('keeps the Pi settings live mid-turn', () => {
        runtime.narrowViewport = true
        runtime.snapshot.thread.isDisabled = true
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
        })
        // The gear must stay clickable while a Pi turn is running (#1442).
        expect(gear()).not.toBeDisabled()
        fireEvent.click(gear())
        expect(choice('Gemini 2.5 Pro')).not.toBeDisabled()
    })

    it('has no gear while the Pi catalog is unresolved', () => {
        // Without a resolved catalog there are no model or effort settings at
        // all, so no provider-less model id can be posted.
        runtime.snapshot.thread.isDisabled = true
        renderComposer('pi', {
            model: 'gemini-2.5-pro',
            piModels: [],
            piSelectedModel: null,
            onPermissionModeChange: undefined,
        })
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
        expect(screen.queryByText('Model')).toBeNull()
    })

    it('clears the Pi thinking level when the selected effort is picked again', () => {
        const effortChanges: Array<string | null> = []
        renderComposer('pi', {
            effort: 'high',
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
            onEffortChange: (level) => effortChanges.push(level),
        })
        fireEvent.click(gear())
        fireEvent.click(choice('High'))
        expect(effortChanges).toEqual([null])
    })

    it('disables the Pi choices when configuration controls turn off', () => {
        const common = {
            sessionId: 'composer-test',
            disabled: false,
            agentFlavor: 'pi' as const,
            model: 'gemini-2.5-pro',
            effort: 'high' as const,
            permissionMode: 'default' as const,
            onModelChange: vi.fn(),
            onEffortChange: vi.fn(),
            onPermissionModeChange: vi.fn(),
            piModels: [{ provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true }],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
            pendingSendIntentRef: runtime.pendingSendIntentRef as { current: ComposerSendIntent },
        }
        const { rerender } = render(
            <I18nProvider>
                <HappyComposer {...common} active={true} />
            </I18nProvider>
        )
        fireEvent.click(gear())
        expect(choice('Gemini 2.5 Pro')).not.toBeDisabled()
        rerender(
            <I18nProvider>
                <HappyComposer {...common} active={false} />
            </I18nProvider>
        )
        expect(choice('Gemini 2.5 Pro')).toBeDisabled()
    })

    it('drills into Cursor variants and returns to the model list after a pick', () => {
        const onModelEffortChange = vi.fn()
        renderComposer('cursor', {
            model: 'composer-2.5-fast',
            selectedModelBase: 'composer-2.5',
            onModelEffortChange,
            availableModelOptions: [
                { value: 'composer-2.5', label: 'Composer 2.5' },
                { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
                { value: 'composer-2.5-mini', label: 'Composer 2.5 Mini' },
            ],
            resolveModelVariantsForBase: (base) => base === 'composer-2.5'
                ? [
                    { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
                    { value: 'composer-2.5-mini', label: 'Composer 2.5 Mini' },
                ]
                : [],
        })
        fireEvent.click(gear())
        fireEvent.click(choice('Composer 2.5'))
        expect(screen.queryByText('Model')).toBeNull()
        expect(screen.getByText('← Models')).toBeTruthy()
        fireEvent.click(choice('Composer 2.5 Mini'))
        expect(onModelEffortChange).toHaveBeenCalledWith('composer-2.5-mini')
        expect(screen.queryByText('← Models')).toBeNull()
        expect(screen.getByText('Model')).toBeTruthy()
    })

    it('resets a Cursor drill-down when the sheet is closed and reopened', () => {
        renderComposer('cursor', {
            model: 'composer-2.5-fast',
            selectedModelBase: 'composer-2.5',
            availableModelOptions: [
                { value: 'composer-2.5', label: 'Composer 2.5' },
                { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
            ],
            resolveModelVariantsForBase: (base) => base === 'composer-2.5'
                ? [
                    { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
                    { value: 'composer-2.5-mini', label: 'Composer 2.5 Mini' },
                ]
                : [],
        })
        fireEvent.click(gear())
        fireEvent.click(choice('Composer 2.5'))
        expect(screen.getByText('← Models')).toBeTruthy()
        fireEvent.click(gear())
        fireEvent.click(gear())
        expect(screen.queryByText('← Models')).toBeNull()
        expect(screen.getByText('Model')).toBeTruthy()
    })
})
