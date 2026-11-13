import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { RemoveWorktreeRequest, RemoveWorktreeResponse } from '@hapi/protocol/apiTypes';
import { isLinkedGitWorktree } from '@/utils/isLinkedGitWorktree';

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  basePath: string;
  worktreePath: string;
  branch: string;
  name: string;
  createdAt: number;
};

type WorktreeResult =
  | { ok: true; info: WorktreeInfo }
  | { ok: false; error: string };

export type RemoveWorktreeResult =
  | { ok: true }
  | { ok: false; error: string };

const MAX_ATTEMPTS = 5;

/**
 * Output ceiling for one git call. execFile's 1 MB default is reached by
 * `git status --porcelain` on a worktree with ~20k changed files, and a
 * truncated answer must not be mistaken for a short one.
 */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
    return {
      stdout: result.stdout ? result.stdout.toString() : '',
      stderr: result.stderr ? result.stderr.toString() : ''
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const stderr = execError.stderr ? execError.stderr.toString() : '';
    const stdout = execError.stdout ? execError.stdout.toString() : '';
    const message = stderr.trim() || stdout.trim() || execError.message || 'Git command failed';
    throw new Error(message);
  }
}

async function resolveRepoRoot(basePath: string): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], basePath);
  const root = result.stdout.trim();
  if (!root) {
    throw new Error('Unable to resolve Git repository root.');
  }
  return root;
}

function toSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned;
}

function formatDatePrefix(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}${day}`;
}

function normalizeNameHint(nameHint?: string): string | null {
  if (!nameHint) {
    return null;
  }
  const trimmed = nameHint.trim();
  if (!trimmed) {
    return null;
  }
  const slug = toSlug(trimmed);
  return slug ? slug : null;
}

function makeDefaultBaseName(): string {
  const suffix = randomBytes(2).toString('hex');
  return `${formatDatePrefix()}-${suffix}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function hasCommits(repoRoot: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function hasGitConfig(repoRoot: string, key: string): Promise<boolean> {
  try {
    const result = await runGit(['config', key], repoRoot);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Give a freshly `git init`-ed repo a root commit so a branch can fork from it.
 *
 * `git worktree add -b` needs a start point, and an unborn HEAD has none
 * ("Not a valid object name: 'HEAD'"). `--orphan` would sidestep this but needs
 * git 2.42+. The commit is empty, so it touches no files. A fallback is
 * supplied for whichever of user.name / user.email the user has not
 * configured; git refuses to commit with either one empty ("empty ident").
 */
async function ensureInitialCommit(repoRoot: string): Promise<void> {
  const identity: string[] = [];
  if (!(await hasGitConfig(repoRoot, 'user.name'))) {
    identity.push('-c', 'user.name=dugong');
  }
  if (!(await hasGitConfig(repoRoot, 'user.email'))) {
    identity.push('-c', 'user.email=dugong@localhost');
  }
  await runGit([...identity, 'commit', '--allow-empty', '--no-verify', '-m', 'Initial commit'], repoRoot);
}

/**
 * Check that a user-supplied base ref names a commit. The ref is free text from
 * the task, so it is passed after `--end-of-options`: a value like `--lock` or
 * `-f` is looked up as a ref (and rejected) instead of being read as an option.
 */
async function verifyBaseRef(repoRoot: string, baseRef: string): Promise<string | null> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`], repoRoot);
    return null;
  } catch {
    return `Base ref "${baseRef}" does not name a commit in ${repoRoot}. Check the branch, tag or sha.`;
  }
}

export async function createWorktree(options: {
  basePath: string;
  nameHint?: string;
  /**
   * Commit-ish the new branch starts from (`main`, a tag, a sha). Omitted, git
   * branches from whatever the primary worktree currently has checked out —
   * which silently inherits any unmerged work sitting there. A task that
   * pins a base ref is asking for a known starting point, so pass it through.
   */
  baseRef?: string;
}): Promise<WorktreeResult> {
  const { basePath, nameHint } = options;
  let baseRef = options.baseRef;
  let repoRoot: string;

  try {
    repoRoot = await resolveRepoRoot(basePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Path is not a Git repository: ${message}`
    };
  }

  if (!(await hasCommits(repoRoot))) {
    try {
      await ensureInitialCommit(repoRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Repository has no commits and creating an initial one failed: ${message}`
      };
    }
    // The root commit is the only commit; a pinned ref (e.g. `main` when the
    // unborn branch was `master`) may not exist, so fork from HEAD instead.
    baseRef = undefined;
  }

  if (baseRef) {
    const baseRefError = await verifyBaseRef(repoRoot, baseRef);
    if (baseRefError) {
      return { ok: false, error: baseRefError };
    }
  }

  const repoParent = dirname(repoRoot);
  const repoName = basename(repoRoot);
  const repoWorktreesRoot = join(repoParent, `${repoName}-worktrees`);
  await mkdir(repoWorktreesRoot, { recursive: true });

  const baseName = normalizeNameHint(nameHint) ?? makeDefaultBaseName();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName}-${randomBytes(2).toString('hex')}`;
    const branch = `dugong-${name}`;
    const worktreePath = join(repoWorktreesRoot, name);

    if (await pathExists(worktreePath)) {
      continue;
    }

    if (await branchExists(repoRoot, branch)) {
      continue;
    }

    try {
      const addArgs = ['worktree', 'add', '-b', branch, '--end-of-options', worktreePath];
      if (baseRef) {
        addArgs.push(baseRef);
      }
      await runGit(addArgs, repoRoot);
      return {
        ok: true,
        info: {
          basePath: repoRoot,
          worktreePath,
          branch,
          name,
          createdAt: Date.now()
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Failed to create worktree: ${message}`
      };
    }
  }

  return {
    ok: false,
    error: 'Failed to create worktree after multiple attempts. Try again.'
  };
}

export async function removeWorktree(options: {
  repoRoot: string;
  worktreePath: string;
}): Promise<RemoveWorktreeResult> {
  try {
    await runGit(['worktree', 'remove', '--force', options.worktreePath], options.repoRoot);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * Uncommitted work in a worktree, as `git status --porcelain` lines.
 *
 * Checked before tearing a worktree down on request: `git worktree remove
 * --force` discards changes silently, and deleting a task is not consent to
 * throw away edits the operator may not know are there. Throws when the status
 * cannot be read: an unknown answer must stop the removal, not allow it.
 */
export async function worktreeDirtyFileCount(worktreePath: string): Promise<number> {
  const result = await runGit(['status', '--porcelain'], worktreePath);
  return result.stdout.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * The repository a linked worktree belongs to, read off the worktree itself
 * (`--git-common-dir` is the main repo's `.git`). Teardown runs its git
 * commands there rather than in a directory the caller names, so a wrong or
 * hostile path cannot point `worktree remove` / `branch -d` at another repo.
 */
export async function resolveWorktreeRepoRoot(worktreePath: string): Promise<string> {
  const raw = (await runGit(['rev-parse', '--git-common-dir'], worktreePath)).stdout.trim();
  if (!raw) {
    throw new Error('Unable to resolve the repository of this worktree.');
  }
  const commonDir = isAbsolute(raw) ? raw : resolve(worktreePath, raw);
  // A bare repository is its own common dir; a normal one keeps it in `.git`.
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The runner side of the RemoveWorktree RPC.
 *
 * Refuses anything that is not a linked worktree (a mistyped path must not
 * take out a primary checkout), keeps uncommitted work unless `force` is set,
 * and fails closed: if the worktree's state cannot be read, nothing is
 * removed. With `probe` it only reports `dirty` or `clean`.
 */
export async function teardownWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResponse> {
  const { worktreePath } = request;
  if (!isLinkedGitWorktree(worktreePath)) {
    return { outcome: 'not-a-worktree' };
  }

  let repoRoot: string;
  try {
    repoRoot = await resolveWorktreeRepoRoot(worktreePath);
  } catch (error) {
    return { outcome: 'error', message: errorMessage(error) };
  }

  if (request.probe === true || request.force !== true) {
    let changedFiles: number;
    try {
      changedFiles = await worktreeDirtyFileCount(worktreePath);
    } catch (error) {
      return {
        outcome: 'error',
        message: `Could not read the worktree's status, so it was left in place: ${errorMessage(error)}`
      };
    }
    if (changedFiles > 0) {
      return { outcome: 'dirty', changedFiles };
    }
  }

  if (request.probe === true) {
    return { outcome: 'clean' };
  }

  if (request.keepUnmerged === true && request.branch
    && await branchHasNewCommits({ repoRoot, branch: request.branch })) {
    return { outcome: 'unmerged' };
  }

  const removal = await removeWorktree({ repoRoot, worktreePath });
  if (!removal.ok) {
    return { outcome: 'error', message: removal.error };
  }

  const branch = request.branch
    ? await deleteMergedBranch({ repoRoot, branch: request.branch })
    : 'skipped' as const;
  return { outcome: 'removed', branch };
}

/**
 * Whether a branch has moved since it was created.
 *
 * Read off the branch's reflog rather than compared with a base ref: the
 * worktree's branch was cut from whatever its base resolved to at the time,
 * and only the reflog still knows that commit. A branch with no reflog (or an
 * unreadable one) counts as moved — the caller keeps it, which is the safe
 * side of being wrong.
 */
export async function branchHasNewCommits(options: { repoRoot: string; branch: string }): Promise<boolean> {
  try {
    const tip = (await runGit(['rev-parse', `refs/heads/${options.branch}`], options.repoRoot)).stdout.trim();
    const log = await runGit(['reflog', 'show', '--format=%H', `refs/heads/${options.branch}`], options.repoRoot);
    const entries = log.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const created = entries.at(-1);
    return !created || created !== tip;
  } catch {
    return true;
  }
}

export type DeleteBranchOutcome = 'deleted' | 'kept-unmerged' | 'not-found' | 'failed';

/**
 * Delete a task branch, but only if git considers it fully merged.
 *
 * Uses `-d`, never `-D`. An unmerged branch holds commits that exist nowhere
 * else; dropping a task is a statement about the task, not permission to
 * discard work. Those branches stay, and the caller reports that they did.
 */
export async function deleteMergedBranch(options: {
  repoRoot: string;
  branch: string;
}): Promise<DeleteBranchOutcome> {
  try {
    await runGit(['rev-parse', '--verify', `refs/heads/${options.branch}`], options.repoRoot);
  } catch {
    return 'not-found';
  }

  try {
    await runGit(['branch', '-d', options.branch], options.repoRoot);
    return 'deleted';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /not fully merged/i.test(message) ? 'kept-unmerged' : 'failed';
  }
}
