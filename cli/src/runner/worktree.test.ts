import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
    branchHasNewCommits,
    createWorktree,
    deleteMergedBranch,
    removeWorktree,
    resolveWorktreeRepoRoot,
    teardownWorktree,
    worktreeDirtyFileCount
} from './worktree';

describe('worktree teardown', () => {
    const temps: string[] = [];

    afterEach(() => {
        for (const dir of temps.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        }
    });

    function tempDir(prefix: string): string {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        temps.push(dir);
        return dir;
    }

    function git(cwd: string, args: string[]): void {
        execFileSync('git', args, {
            cwd,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'test',
                GIT_AUTHOR_EMAIL: 'test@example.com',
                GIT_COMMITTER_NAME: 'test',
                GIT_COMMITTER_EMAIL: 'test@example.com'
            }
        });
    }

    /** A repo with one commit on a branch named `main`. */
    function makeRepo(): string {
        const repo = tempDir('hapi-worktree-');
        git(repo, ['init']);
        // `--initial-branch` needs git 2.28+; `symbolic-ref` on an unborn HEAD
        // does the same thing everywhere.
        git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
        writeFileSync(join(repo, 'README'), 'x\n');
        git(repo, ['add', 'README']);
        git(repo, ['commit', '-m', 'init']);
        return repo;
    }

    async function makeWorktree(repo: string, nameHint: string): Promise<{ path: string; branch: string }> {
        const result = await createWorktree({ basePath: repo, nameHint });
        if (!result.ok) throw new Error(result.error);
        return { path: result.info.worktreePath, branch: result.info.branch };
    }

    describe('worktreeDirtyFileCount', () => {
        it('reports zero for a clean worktree', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'clean');
            expect(await worktreeDirtyFileCount(worktree.path)).toBe(0);
        });

        it('counts untracked and modified files', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'dirty');

            writeFileSync(join(worktree.path, 'scratch.txt'), 'new\n');
            writeFileSync(join(worktree.path, 'README'), 'changed\n');

            expect(await worktreeDirtyFileCount(worktree.path)).toBe(2);
        });

        it('throws for an unreadable path instead of calling it clean', async () => {
            await expect(worktreeDirtyFileCount(join(tmpdir(), 'hapi-does-not-exist'))).rejects.toThrow();
        });

        it('counts past the default 1 MB exec buffer', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'many');
            // ~40 bytes per porcelain line; 30k files is well past 1 MB.
            for (let i = 0; i < 30_000; i++) {
                writeFileSync(join(worktree.path, `untracked-file-with-a-longish-name-${i}.txt`), '');
            }
            expect(await worktreeDirtyFileCount(worktree.path)).toBe(30_000);
        }, 60_000);
    });

    describe('resolveWorktreeRepoRoot', () => {
        it('finds the repository a worktree belongs to', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'owner');
            expect(realpathSync(await resolveWorktreeRepoRoot(worktree.path))).toBe(realpathSync(repo));
        });
    });

    describe('teardownWorktree', () => {
        it('probes without removing anything', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'probe');
            expect(await teardownWorktree({ worktreePath: worktree.path, probe: true })).toEqual({ outcome: 'clean' });

            writeFileSync(join(worktree.path, 'scratch.txt'), 'new\n');
            expect(await teardownWorktree({ worktreePath: worktree.path, probe: true, force: true }))
                .toEqual({ outcome: 'dirty', changedFiles: 1 });
            expect(existsSync(join(worktree.path, 'scratch.txt'))).toBe(true);
        });

        it('keeps a dirty worktree unless forced', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'keepdirty');
            writeFileSync(join(worktree.path, 'scratch.txt'), 'new\n');

            expect(await teardownWorktree({ worktreePath: worktree.path })).toEqual({ outcome: 'dirty', changedFiles: 1 });
            expect(existsSync(worktree.path)).toBe(true);

            expect(await teardownWorktree({ worktreePath: worktree.path, force: true, branch: worktree.branch }))
                .toEqual({ outcome: 'removed', branch: 'deleted' });
            expect(existsSync(worktree.path)).toBe(false);
        });

        it('removes nothing when the status cannot be read', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'unreadable');
            writeFileSync(join(worktree.path, 'scratch.txt'), 'new\n');
            // A corrupt index makes `git status` fail while the worktree is
            // still recognisably a linked worktree.
            const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree.path, encoding: 'utf8' }).trim();
            writeFileSync(resolve(worktree.path, gitDir, 'index'), 'garbage');

            const result = await teardownWorktree({ worktreePath: worktree.path });
            expect(result.outcome).toBe('error');
            expect(existsSync(join(worktree.path, 'scratch.txt'))).toBe(true);
        });

        it('refuses a primary checkout', async () => {
            const repo = makeRepo();
            expect(await teardownWorktree({ worktreePath: repo, force: true })).toEqual({ outcome: 'not-a-worktree' });
        });
    });

    describe('deleteMergedBranch', () => {
        it('deletes a branch with no commits of its own', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'merged');

            // Remove the worktree first — git refuses to delete a checked-out branch.
            expect((await removeWorktree({ repoRoot: repo, worktreePath: worktree.path })).ok).toBe(true);
            expect(await deleteMergedBranch({ repoRoot: repo, branch: worktree.branch })).toBe('deleted');
        });

        it('keeps a branch that still holds unmerged work', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'unmerged');

            writeFileSync(join(worktree.path, 'feature.txt'), 'work\n');
            git(worktree.path, ['add', 'feature.txt']);
            git(worktree.path, ['commit', '-m', 'feature']);

            await removeWorktree({ repoRoot: repo, worktreePath: worktree.path });

            expect(await deleteMergedBranch({ repoRoot: repo, branch: worktree.branch })).toBe('kept-unmerged');
            // The commit is still reachable.
            const branches = execFileSync('git', ['branch', '--list', worktree.branch], { cwd: repo, encoding: 'utf8' });
            expect(branches.trim().length).toBeGreaterThan(0);
        });

        it('reports a branch that is not there', async () => {
            const repo = makeRepo();
            expect(await deleteMergedBranch({ repoRoot: repo, branch: 'no-such-branch' })).toBe('not-found');
        });
    });

    describe('branchHasNewCommits', () => {
        it('says no for a branch still where it was cut', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'untouched');
            expect(await branchHasNewCommits({ repoRoot: repo, branch: worktree.branch })).toBe(false);
        });

        it('says yes once the branch has a commit of its own', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'committed');
            writeFileSync(join(worktree.path, 'feature.txt'), 'work\n');
            git(worktree.path, ['add', 'feature.txt']);
            git(worktree.path, ['commit', '-m', 'feature']);
            expect(await branchHasNewCommits({ repoRoot: repo, branch: worktree.branch })).toBe(true);
        });

        it('errs on the side of keeping a branch it cannot read', async () => {
            const repo = makeRepo();
            expect(await branchHasNewCommits({ repoRoot: repo, branch: 'no-such-branch' })).toBe(true);
        });
    });

    describe('removeWorktree', () => {
        it('removes the checkout but leaves the branch behind', async () => {
            const repo = makeRepo();
            const worktree = await makeWorktree(repo, 'removeme');

            expect((await removeWorktree({ repoRoot: repo, worktreePath: worktree.path })).ok).toBe(true);

            const list = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
            expect(list).not.toContain(worktree.path);
            const branches = execFileSync('git', ['branch', '--list', worktree.branch], { cwd: repo, encoding: 'utf8' });
            expect(branches.trim().length).toBeGreaterThan(0);
        });
    });
    describe('createWorktree', () => {
        it('forks from a freshly initialised repo with no commits', async () => {
            const repo = tempDir('hapi-worktree-empty-');
            git(repo, ['init']);
            git(repo, ['config', 'user.name', 'test']);
            git(repo, ['config', 'user.email', 'test@example.com']);

            const result = await createWorktree({ basePath: repo, nameHint: 'first', baseRef: 'main' });
            if (!result.ok) throw new Error(result.error);
            temps.push(join(repo, '..', `${basename(repo)}-worktrees`));

            const log = execFileSync('git', ['log', '--format=%s', result.info.branch], { cwd: repo }).toString().trim();
            expect(log).toBe('Initial commit');
        });

        it('fills in a missing user.name for the initial commit', async () => {
            const repo = tempDir('hapi-worktree-noname-');
            git(repo, ['init']);
            git(repo, ['config', 'user.email', 'only-email@example.com']);
            const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
            process.env.GIT_CONFIG_GLOBAL = '/dev/null';
            process.env.GIT_CONFIG_NOSYSTEM = '1';
            try {
                const result = await createWorktree({ basePath: repo, nameHint: 'noname' });
                if (!result.ok) throw new Error(result.error);
                temps.push(join(repo, '..', `${basename(repo)}-worktrees`));
                const author = execFileSync('git', ['log', '--format=%an <%ae>', result.info.branch], { cwd: repo }).toString().trim();
                expect(author).toBe('dugong <only-email@example.com>');
            } finally {
                if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
                else process.env.GIT_CONFIG_GLOBAL = saved.global;
                if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
                else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
            }
        });

        it('forks from the given base ref', async () => {
            const repo = makeRepo();
            git(repo, ['checkout', '-b', 'other']);
            git(repo, ['commit', '--allow-empty', '-m', 'on other']);
            const result = await createWorktree({ basePath: repo, nameHint: 'based', baseRef: 'main' });
            if (!result.ok) throw new Error(result.error);
            temps.push(join(repo, '..', `${basename(repo)}-worktrees`));
            const subject = execFileSync('git', ['log', '-1', '--format=%s', result.info.branch], { cwd: repo }).toString().trim();
            expect(subject).toBe('init');
        });

        it('rejects a base ref that does not name a commit', async () => {
            const repo = makeRepo();
            temps.push(join(repo, '..', `${basename(repo)}-worktrees`));
            const result = await createWorktree({ basePath: repo, nameHint: 'typo', baseRef: 'mian' });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toContain('Base ref "mian" does not name a commit');
        });

        it('does not read an option-like base ref as a git option', async () => {
            const repo = makeRepo();
            temps.push(join(repo, '..', `${basename(repo)}-worktrees`));
            const result = await createWorktree({ basePath: repo, nameHint: 'opt', baseRef: '--no-checkout' });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toContain('Base ref "--no-checkout" does not name a commit');
            const branches = execFileSync('git', ['branch', '--list', 'dugong-opt'], { cwd: repo, encoding: 'utf8' });
            expect(branches.trim()).toBe('');
        });
    });
});
