import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
    {
        variants: {
            variant: {
                default: 'border-[var(--app-border)] text-[var(--app-fg)]',
                warning: 'border-[var(--app-border)] text-[var(--app-badge-warning-text)]',
                success: 'border-[var(--app-border)] text-[var(--app-badge-success-text)]',
                destructive: 'border-[var(--app-accent)] text-[var(--app-accent)]'
            }
        },
        defaultVariants: {
            variant: 'default'
        }
    }
)

export interface BadgeProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
    return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}
