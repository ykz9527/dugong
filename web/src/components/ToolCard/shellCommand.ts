import { isObject } from '@hapi/protocol'
import { getInputStringAny } from '@/lib/toolInputUtils'

export const TERMINAL_RELATED_TOOL_NAMES = new Set(['Bash', 'CodexBash', 'exec_command', 'shell', 'shell_command', 'run_shell_command'])

const SHELL_WRAPPER_RE = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh$/
const SHELL_SCRIPT_FLAG_RE = /^-l?c$/
const SAFE_SHELL_WORD_RE = /^[\w@%+=:,./-]+$/

function quoteShellWord(word: string): string {
    return SAFE_SHELL_WORD_RE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * The command a shell tool call ran, as text a person can paste at a prompt.
 * Codex records argv (`["bash", "-lc", "<script>"]`); the script is what the
 * user wants, and other argv is re-quoted so it means the same in a shell.
 */
export function getRunnableShellCommand(toolName: string, input: unknown): string | null {
    if (!TERMINAL_RELATED_TOOL_NAMES.has(toolName)) {
        return null
    }
    const text = getInputStringAny(input, ['command', 'cmd'])
    if (text) {
        return text.trim() || null
    }
    if (!isObject(input) || !Array.isArray(input.command)) {
        return null
    }
    const argv = input.command.filter((part): part is string => typeof part === 'string')
    if (argv.length === 3 && SHELL_WRAPPER_RE.test(argv[0]) && SHELL_SCRIPT_FLAG_RE.test(argv[1])) {
        return argv[2].trim() || null
    }
    return argv.length > 0 ? argv.map(quoteShellWord).join(' ') : null
}
