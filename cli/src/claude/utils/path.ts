import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Claude's directory name for a working directory: the absolute path with
 * every non-alphanumeric character replaced by a dash.
 *
 * Exported because the name alone says which directory a transcript belongs
 * to, which lets a listing skip whole projects without opening a file. The
 * mapping is lossy (`/a/b` and `/a-b` collide), so it is only ever safe as a
 * pre-filter ahead of the real check.
 */
export function encodeProjectDirName(workingDirectory: string): string {
    return resolve(workingDirectory).replace(/[^a-zA-Z0-9]/g, '-');
}

export function getProjectPath(workingDirectory: string) {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', encodeProjectDirName(workingDirectory));
}