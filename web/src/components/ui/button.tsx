import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
    'inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-semibold transition-[color,background-color,border-color,opacity] duration-300 disabled:pointer-events-none disabled:opacity-50',
    {
        variants: {
            variant: {
                default: 'pw-sweep bg-[var(--app-button)] text-[var(--app-button-text)]',
                secondary: 'pw-row-fill overflow-hidden border border-[var(--app-border)] bg-transparent text-[var(--app-fg)]',
                outline: 'pw-ghost-sweep border border-[var(--app-fg)] bg-transparent',
                destructive: 'pw-sweep border border-[var(--app-accent)] bg-transparent text-[var(--app-accent)] hover:text-white'
            },
            size: {
                default: 'h-9 px-4 py-2',
                sm: 'h-8 px-3.5 text-[13px]',
                lg: 'h-12 px-7 text-[15px]'
            }
        },
        defaultVariants: {
            variant: 'default',
            size: 'default'
        }
    }
)

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {
    asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : 'button'
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        )
    }
)
Button.displayName = 'Button'

