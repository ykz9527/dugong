import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'
import { CloseIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    closeButtonClassName?: string
}

export const DialogContent = React.forwardRef<
    HTMLDivElement,
    DialogContentProps
>(({ className, closeButtonClassName, children, ...props }, ref) => {
    const { t } = useTranslation()
    return (
        <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="pw-overlay fixed inset-0 z-50 bg-black/40" />
            {/* Centred by inset + auto margins: pw-pop animates `translate`, which would cancel translate-based centring. */}
            <DialogPrimitive.Content
                ref={ref}
                className={cn(
                    'pw-pop fixed inset-0 z-50 m-auto h-fit max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-lg overflow-y-auto border border-[var(--app-rule)] bg-[var(--app-dialog-bg)] p-5 text-[var(--app-fg)]',
                    className
                )}
                {...props}
            >
                {children}
                <DialogPrimitive.Close
                    className={cn(
                        'absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors duration-300 hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                        closeButtonClassName
                    )}
                    aria-label={t('button.close')}
                >
                    <CloseIcon className="h-4 w-4" />
                </DialogPrimitive.Close>
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    )
})
DialogContent.displayName = 'DialogContent'

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    // pr-12 reserves space for the absolutely-positioned close button (top-right)
    // so long/breaking titles don't wrap underneath the tap target.
    <div className={cn('flex flex-col space-y-1.5 pr-12 text-center sm:text-left', className)} {...props} />
)

export const DialogTitle = React.forwardRef<
    HTMLHeadingElement,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn('text-[17px] font-medium leading-tight tracking-[-0.02em]', className)}
        {...props}
    />
))
DialogTitle.displayName = 'DialogTitle'

export const DialogDescription = React.forwardRef<
    HTMLParagraphElement,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn('text-sm text-[var(--app-hint)]', className)}
        {...props}
    />
))
DialogDescription.displayName = 'DialogDescription'
