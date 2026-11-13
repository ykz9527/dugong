import { bridgeLegacyRunnerHandoffEnv } from './legacyRunnerHandoffEnv';

// Disable Ink devtools in compiled binaries to avoid optional dependencies.
process.env.DEV = 'false';

bridgeLegacyRunnerHandoffEnv();

await import('./index');

export {};
