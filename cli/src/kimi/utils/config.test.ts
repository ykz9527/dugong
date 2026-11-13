import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The legacy ~/.kimi lookup reads the real home directory; point it at an
// empty one so a developer's own Kimi config cannot leak into these tests.
const fakeHome = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: pathJoin } = require('node:path') as typeof import('node:path');
    return mkdtempSync(pathJoin(os.tmpdir(), 'kimi-home-'));
});
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => fakeHome };
});

import { resolveKimiRuntimeConfig } from './config';

afterAll(() => {
    rmSync(fakeHome, { recursive: true, force: true });
});

describe('resolveKimiRuntimeConfig', () => {
    let homeDir: string;
    let previousHome: string | undefined;

    beforeEach(async () => {
        previousHome = process.env.KIMI_CODE_HOME;
        homeDir = join(tmpdir(), `kimi-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(homeDir, { recursive: true });
        process.env.KIMI_CODE_HOME = homeDir;
    });

    afterEach(async () => {
        if (previousHome === undefined) {
            delete process.env.KIMI_CODE_HOME;
        } else {
            process.env.KIMI_CODE_HOME = previousHome;
        }
        if (existsSync(homeDir)) {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('prefers the explicit model', async () => {
        await writeFile(join(homeDir, 'config.toml'), 'default_model = "kimi-code/k3"\n');
        expect(resolveKimiRuntimeConfig({ model: 'explicit-model' })).toEqual({
            model: 'explicit-model',
            modelSource: 'explicit'
        });
    });

    it('reads default_model from the new kimi-code home', async () => {
        await writeFile(join(homeDir, 'config.toml'), 'default_model = "kimi-code/k3"\n');
        expect(resolveKimiRuntimeConfig()).toEqual({
            model: 'kimi-code/k3',
            modelSource: 'local'
        });
    });

    it('returns no model when nothing is configured (no hardcoded fallback)', () => {
        expect(resolveKimiRuntimeConfig()).toEqual({
            model: undefined,
            modelSource: 'default'
        });
    });

    it('falls back to the legacy ~/.kimi config', async () => {
        await mkdir(join(fakeHome, '.kimi'), { recursive: true });
        await writeFile(join(fakeHome, '.kimi', 'config.toml'), 'default_model = "kimi-legacy"\n');
        try {
            expect(resolveKimiRuntimeConfig()).toEqual({
                model: 'kimi-legacy',
                modelSource: 'local'
            });
        } finally {
            await rm(join(fakeHome, '.kimi'), { recursive: true, force: true });
        }
    });
});
