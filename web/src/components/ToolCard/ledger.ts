/**
 * Wrapper class for one item in a run of chat ledger rows (tool calls, tool
 * groups, reasoning). Mark the element with `data-pw-tool` as well.
 *
 * Consecutive items sit flush on shared hairlines (each row draws its own top
 * line via `.pw-ledger`); the last item of a run closes with a bottom hairline,
 * and a run keeps a little air from the text around it.
 */
export const LEDGER_RUN_ITEM_CLASS = [
    'min-w-0 max-w-full',
    '[&:not([data-pw-tool]+*)]:mt-2',
    '[&:not(:has(+[data-pw-tool]))]:mb-2',
    '[&:not(:has(+[data-pw-tool]))]:border-b',
    '[&:not(:has(+[data-pw-tool]))]:border-[var(--app-border)]',
].join(' ')
