import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { CloseIcon } from '@/components/icons'

const toastVariants = cva(
    'pointer-events-auto w-full max-w-sm border border-[var(--app-rule)] bg-[var(--app-bg)] text-[var(--app-fg)]',
    {
        variants: {
            variant: {
                default: 'border-[var(--app-rule)] bg-[var(--app-bg)]'
            }
        },
        defaultVariants: {
            variant: 'default'
        }
    }
)

export type ToastProps = React.HTMLAttributes<HTMLDivElement> &
    VariantProps<typeof toastVariants> & {
    title: string
    body: string
    onClose?: () => void
}

export function Toast({ title, body, onClose, className, variant, ...props }: ToastProps) {
    const handleClose = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        onClose?.()
    }

    return (
        <div className={cn(toastVariants({ variant }), className)} role="status" {...props}>
            <div className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium leading-5">{title}</div>
                    <div className="mt-1 text-[13px] text-[var(--app-hint)]">{body}</div>
                </div>
                {onClose ? (
                    <button
                        type="button"
                        className="pw-ghost-sweep -m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)]"
                        onClick={handleClose}
                        aria-label="Dismiss"
                    >
                        <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                ) : null}
            </div>
        </div>
    )
}
