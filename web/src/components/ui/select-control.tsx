import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export interface SelectControlProps extends SelectHTMLAttributes<HTMLSelectElement> {
    containerClassName?: string
    /** Position/size overrides for the chevron, e.g. `right-0` for an underline field. */
    chevronClassName?: string
}

export const SelectControl = forwardRef<HTMLSelectElement, SelectControlProps>(
    function SelectControl({ children, className, containerClassName = '', chevronClassName, ...props }, ref) {
        return (
            <span className={`relative block min-w-0 ${containerClassName}`}>
                <select
                    ref={ref}
                    className={cn('peer w-full appearance-none pr-10', className)}
                    {...props}
                >
                    {children}
                </select>
                <svg
                    aria-hidden="true"
                    className={cn(
                        'pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-fg)] peer-disabled:opacity-50',
                        chevronClassName
                    )}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </span>
        )
    }
)
