import { describe, expect, it } from 'vitest';
import { rewriteReadmeForNpm } from './prepare-npm-packages';

describe('rewriteReadmeForNpm', () => {
    it('points repo-relative images at raw files and links at the GitHub page', () => {
        const readme = [
            '<source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">',
            '<img src="docs/assets/logo.svg" width="88">',
            '<a href="LICENSE">License</a>',
            '![shot](./docs/assets/shot.png)',
            'See [the handbook](docs/handbook.zh-CN.md) and [contributing](CONTRIBUTING.md "how").',
        ].join('\n');

        expect(rewriteReadmeForNpm(readme).split('\n')).toEqual([
            '<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ykz9527/dugong/main/docs/assets/logo-dark.svg">',
            '<img src="https://raw.githubusercontent.com/ykz9527/dugong/main/docs/assets/logo.svg" width="88">',
            '<a href="https://github.com/ykz9527/dugong/blob/main/LICENSE">License</a>',
            '![shot](https://raw.githubusercontent.com/ykz9527/dugong/main/docs/assets/shot.png)',
            'See [the handbook](https://github.com/ykz9527/dugong/blob/main/docs/handbook.zh-CN.md) and [contributing](https://github.com/ykz9527/dugong/blob/main/CONTRIBUTING.md "how").',
        ]);
    });

    it('leaves absolute URLs and in-page anchors alone', () => {
        const readme = [
            '<a href="https://github.com/ykz9527/dugong/actions"><img src="https://img.shields.io/badge/x"></a>',
            '<a href="#quick-start">Quick start</a>',
            '[Bun](https://bun.sh) [mail](mailto:a@b.c) [faq](#faq)',
        ].join('\n');

        expect(rewriteReadmeForNpm(readme)).toBe(readme);
    });
});
