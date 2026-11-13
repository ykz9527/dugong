import { useState, useEffect, useRef } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

type RenameSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    currentName: string
    onRename: (newName: string) => Promise<void>
    onSuggestTitle?: () => Promise<string>
    onUpdateSummary?: (text: string) => Promise<void>
    isPending: boolean
}

export function RenameSessionDialog(props: RenameSessionDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, currentName, onRename, onSuggestTitle, onUpdateSummary, isPending } = props
    const [name, setName] = useState(currentName)
    const [error, setError] = useState<string | null>(null)
    const [draftSource, setDraftSource] = useState<'manual' | 'generated'>('manual')
    const [draftEdited, setDraftEdited] = useState(false)
    const [isGenerating, setIsGenerating] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const generationRef = useRef(0)
    const busy = isPending || isGenerating

    const handleClose = () => {
        generationRef.current += 1
        setIsGenerating(false)
        onClose()
    }

    useEffect(() => {
        generationRef.current += 1
        if (!isOpen) {
            setIsGenerating(false)
            return
        }

        if (isOpen) {
            setName(currentName)
            setError(null)
            setDraftSource('manual')
            setDraftEdited(false)
            setIsGenerating(false)
            setTimeout(() => {
                inputRef.current?.focus()
                inputRef.current?.select()
            }, 100)
        }
    }, [isOpen, currentName])

    const handleGenerate = async () => {
        if (!onSuggestTitle) return

        const generation = ++generationRef.current
        setError(null)
        setIsGenerating(true)
        try {
            const suggested = (await onSuggestTitle()).trim()
            if (generation !== generationRef.current) return
            if (!suggested) throw new Error('Empty title suggestion')
            setName(suggested)
            setDraftSource('generated')
        } catch {
            if (generation === generationRef.current) {
                setError(t('dialog.rename.generateError'))
            }
        } finally {
            if (generation === generationRef.current) {
                setIsGenerating(false)
            }
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed || (!draftEdited && draftSource === 'manual' && trimmed === currentName)) {
            handleClose()
            return
        }
        setError(null)
        try {
            if (draftSource === 'generated' && onUpdateSummary) {
                await onUpdateSummary(trimmed)
            } else {
                await onRename(trimmed)
            }
            handleClose()
        } catch {
            setError(t('dialog.rename.error'))
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            handleClose()
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {t('dialog.rename.title')}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
                    <input
                        ref={inputRef}
                        type="text"
                        value={name}
                        onChange={(e) => {
                            setName(e.target.value)
                            setDraftSource('manual')
                            setDraftEdited(true)
                        }}
                        onKeyDown={handleKeyDown}
                        placeholder={t('dialog.rename.placeholder')}
                        aria-label={t('dialog.rename.title')}
                        className="w-full rounded-none border-0 border-b border-[var(--app-rule)] bg-transparent pb-[9px] pt-2 text-[17px] leading-[1.3] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] disabled:opacity-50"
                        disabled={busy}
                        maxLength={255}
                    />

                    {error ? (
                        <div role="alert" className="text-[13px] text-[var(--app-accent)]">
                            {error}
                        </div>
                    ) : null}

                    <div className="flex items-center justify-between gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleClose}
                            disabled={busy}
                        >
                            {t('button.cancel')}
                        </Button>
                        <div className="flex gap-2">
                            {onSuggestTitle ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => void handleGenerate()}
                                    disabled={busy}
                                >
                                    {isGenerating ? t('dialog.rename.generating') : t('dialog.rename.generate')}
                                </Button>
                            ) : null}
                            <Button
                                type="submit"
                                disabled={busy || !name.trim()}
                            >
                                {isPending ? t('dialog.rename.saving') : t('button.save')}
                            </Button>
                        </div>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}
