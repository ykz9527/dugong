import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shareTargetPathnameFromBase } from './src/lib/sharePath'

function spaFallback(): Plugin {
    return {
        name: 'spa-fallback',
        configureServer(server) {
            server.middlewares.use((req, _res, next) => {
                const url = (req.url ?? '').split('?')[0]
                if (url === '/' || url === '' || url.includes('.') || url.startsWith('/@') || url.startsWith('/api') || url.startsWith('/socket.io') || url.startsWith('/src/')) {
                    next()
                    return
                }
                req.url = '/index.html'
                next()
            })
        }
    }
}

/**
 * What the service worker precaches: the shell and the screens people open
 * every day, found by walking the bundle's static imports from them.
 *
 * Precaching all ~9 MB (diagram renderers, every shiki grammar, KaTeX fonts
 * in three formats, voice SDKs) meant a phone pulled the lot over the relay
 * after its first visit and after every deploy, competing with the requests
 * the user was waiting on. The rest is cached the first time it is used.
 */
const PRECACHED_LAZY_MODULES = [
    /\/src\/components\/SessionChat\.tsx$/,
    /\/src\/components\/NewSession\/index\.tsx?$/,
    /\/src\/components\/Assistant\/AssistantPanel\.tsx$/,
    /\/src\/components\/Tasks\/TaskDetailPanel\.tsx$/,
    /\/src\/routes\/(?!sessions\/terminal)/
]
const precachedAssets = new Set<string>()

function collectPrecachedAssets(): Plugin {
    return {
        name: 'collect-precached-assets',
        apply: 'build',
        generateBundle(_options, bundle) {
            precachedAssets.clear()
            const visit = (fileName: string) => {
                const chunk = bundle[fileName]
                if (!chunk || precachedAssets.has(fileName)) return
                precachedAssets.add(fileName)
                if (chunk.type !== 'chunk') return
                chunk.imports.forEach(visit)
                chunk.viteMetadata?.importedCss.forEach(visit)
                chunk.viteMetadata?.importedAssets.forEach(visit)
            }
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk') continue
                const id = chunk.facadeModuleId ?? ''
                if (chunk.isEntry || PRECACHED_LAZY_MODULES.some((pattern) => pattern.test(id))) {
                    visit(chunk.fileName)
                }
            }
        }
    }
}

const base = process.env.VITE_BASE_URL || '/'
const shareAction = shareTargetPathnameFromBase(base)
const hubTarget = process.env.VITE_HUB_PROXY || 'http://127.0.0.1:3006'
const appVersion = readAppVersion()

function readAppVersion(): string {
    const buildInfoPath = resolve(__dirname, '../shared/src/buildInfo.ts')
    const buildInfo = readFileSync(buildInfoPath, 'utf8')
    const match = buildInfo.match(/export const APP_VERSION = ['"]([^'"]+)['"]/)

    if (!match) {
        throw new Error(`Could not read APP_VERSION from ${buildInfoPath}`)
    }

    return match[1]
}

function getVendorChunkName(id: string): string | undefined {
    if (!id.includes('/node_modules/') && !id.startsWith('\0commonjsHelpers')) {
        return undefined
    }

    // What the first screen shares with the chat UI. Left to rollup, these
    // land in the manual chunk that first pulls them in (vendor-assistant),
    // and the entry then preloads that whole chat-UI chunk to get React.
    if (id.startsWith('\0commonjsHelpers') || /\/node_modules\/(react|react-dom|scheduler|use-sync-external-store|@radix-ui)\//.test(id)) {
        return 'vendor-core'
    }

    if (id.includes('/node_modules/@xterm/')) {
        return 'vendor-terminal'
    }

    if (
        id.includes('/node_modules/@assistant-ui/')
        || id.includes('/node_modules/remark-gfm/')
        || id.includes('/node_modules/hast-util-to-jsx-runtime/')
    ) {
        return 'vendor-assistant'
    }

    if (id.includes('/node_modules/@elevenlabs/react/')) {
        return 'vendor-voice'
    }

    return undefined
}

export default defineConfig({
    appType: 'spa',
    define: {
        __APP_VERSION__: JSON.stringify(appVersion),
    },
    server: {
        host: true,
        proxy: {
            '/api': {
                target: hubTarget,
                changeOrigin: true
            },
            '/socket.io': {
                target: hubTarget,
                ws: true
            }
        }
    },
    plugins: [
        react(),
        spaFallback(),
        collectPrecachedAssets(),
        VitePWA({
            // User-controlled reload avoids mid-session surprise reloads (autoUpdate reloads all tabs).
            registerType: 'prompt',
            includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'mask-icon.svg'],
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            manifest: {
                name: 'dugong',
                short_name: 'dugong',
                description: 'AI-powered development assistant',
                theme_color: '#fcfcfb',
                background_color: '#fcfcfb',
                display: 'standalone',
                orientation: 'portrait',
                scope: base,
                start_url: base,
                icons: [
                    {
                        src: 'pwa-64x64.png',
                        sizes: '64x64',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-maskable-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'maskable'
                    },
                    {
                        src: 'pwa-maskable-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable'
                    }
                ],
                // Web Share Target — Android Chrome routes POSTs to /share
                // when the user picks dugong in the system share sheet. The
                // service worker (`web/src/sw.ts`) intercepts POST /share,
                // stashes the multipart payload in IndexedDB, and 303-
                // redirects to /share?id=<transferId> for the SPA picker.
                // `*/*` is the broad fallback; explicit MIME prefixes stay
                // first because some Chrome versions only honor declared
                // prefixes when surfacing in the share sheet.
                share_target: {
                    action: shareAction,
                    method: 'POST',
                    enctype: 'multipart/form-data',
                    params: {
                        title: 'title',
                        text: 'text',
                        url: 'url',
                        files: [
                            {
                                name: 'files',
                                accept: [
                                    'image/*',
                                    'application/pdf',
                                    'text/*',
                                    'application/json',
                                    'application/zip',
                                    '*/*'
                                ]
                            }
                        ]
                    }
                }
            },
            injectManifest: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
                // Keep the entry chunk in the precache however large it grows.
                maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
                manifestTransforms: [async (entries) => ({
                    manifest: entries.filter((entry) => !entry.url.startsWith('assets/') || precachedAssets.has(entry.url)),
                    warnings: []
                })]
            },
            devOptions: {
                enabled: true,
                type: 'module'
            }
        })
    ],
    base,
    optimizeDeps: {
        // dev 下 VitePWA 会给每个页面注入 service worker 注册，而 sw.ts 里的
        // workbox 依赖要等 SW 真正注册后才被 Vite 发现，触发一次「optimized
        // dependencies changed → reloading」的整页刷新。这个刷新会打断当时
        // 正在跑的 e2e（表现为元素凭空消失）。提前声明即可在启动时一次预构建。
        include: [
            'workbox-precaching',
            'workbox-routing',
            'workbox-strategies',
            'workbox-expiration'
        ]
    },
    resolve: {
        // 单例 React 兜底：workspace 里个别依赖（如 @radix-ui/react-popover）
        // 没被链进 web/node_modules，只能从仓库根解析，于是拿到与应用代码
        // 不同的那份 react 实例。两份 React 同时存在会让带 hook 的第三方
        // 组件在渲染时抛 "Invalid hook call"，并连累整棵 React 树卸载。
        dedupe: ['react', 'react-dom'],
        alias: {
            '@': resolve(__dirname, 'src')
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    return getVendorChunkName(id)
                }
            }
        }
    }
})
