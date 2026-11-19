/**
 * Arguments for a `runner start-sync` that replaces a running runner.
 *
 * A runner started with `--workspace-root` only spawns sessions under those
 * roots, and with no roots it allows every path. A replacement started with
 * bare `runner start-sync` would silently drop that restriction, so carry the
 * roots over from the argv the running runner recorded at start.
 */
export function runnerRestartArgs(previousArgv: readonly string[] | undefined): string[] {
    const args = ['runner', 'start-sync']
    if (!previousArgv) {
        return args
    }
    for (let index = 0; index < previousArgv.length; index += 1) {
        const arg = previousArgv[index]
        if (arg === '--workspace-root') {
            const value = previousArgv[index + 1]
            if (value) {
                args.push(arg, value)
                index += 1
            }
        } else if (arg?.startsWith('--workspace-root=')) {
            args.push(arg)
        }
    }
    return args
}
