/**
 * Where the site lives. dugong has no domain of its own yet; this is the
 * GitHub Pages address and is only used for canonical and Open Graph URLs.
 * Change it here (or set VITE_SITE_URL at build time) once the site moves.
 * Serving the site under a sub-path such as /dugong/ also needs `base` in
 * vite.config.ts and docs/.vitepress/config.ts.
 */
export const SITE_URL: string = (import.meta.env.VITE_SITE_URL as string | undefined) ?? "https://ykz9527.github.io/dugong";

export const GITHUB_REPO = "ykz9527/dugong";
export const REPO_URL = `https://github.com/${GITHUB_REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const UPSTREAM_URL = "https://github.com/tiann/hapi";
export const DOCS_URL = "/docs/";

export const INSTALL_COMMAND = "npm install -g @ykz9527/dugong";
export const HUB_COMMAND = "dugong hub";
export const RUNNER_COMMAND = "dugong runner start --workspace-root ~/code";
