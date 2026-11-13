import { defineConfig } from 'vitepress'

const repo = 'https://github.com/ykz9527/dugong'

export default defineConfig({
  title: 'dugong',
  description: 'Run your coding agents as tasks, from a browser or your phone',
  base: '/docs/',

  // Some pages (the handbook, divergence.md) link to files elsewhere in the repo,
  // such as ../README.md. Those exist on GitHub, not in the built site. Links to
  // http://localhost:3006 point at the reader's own hub.
  ignoreDeadLinks: [/^\.\/\.\.\//, /^\.\.\//, /^https?:\/\/localhost/],

  head: [
    ['link', { rel: 'icon', href: '/docs/favicon.ico' }],
  ],

  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg' },

    nav: [
      { text: 'Quick start', link: '/guide/quick-start' },
      { text: 'Releases', link: `${repo}/releases` }
    ],

    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Quick start', link: '/guide/quick-start' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Install on your phone', link: '/guide/pwa' }
        ]
      },
      {
        text: 'Guide',
        items: [
          { text: 'How it works', link: '/guide/how-it-works' },
          { text: 'Tasks and the assistant', link: '/guide/tasks' },
          { text: 'Agents', link: '/guide/agents' },
          { text: 'Notifications', link: '/guide/notifications' },
          { text: 'Voice', link: '/guide/voice-assistant' },
          { text: 'Why dugong', link: '/guide/why-dugong' },
          { text: 'FAQ', link: '/guide/faq' }
        ]
      },
      {
        text: 'Running a hub',
        items: [
          { text: 'Deployment', link: '/guide/deployment' },
          { text: 'Several people on one hub', link: '/guide/namespace' }
        ]
      },
      {
        text: 'Project',
        items: [
          { text: 'What dugong changes in HAPI', link: '/divergence' },
          { text: 'Writing style', link: '/writing-style' },
          { text: '使用手册（中文）', link: '/handbook.zh-CN' },
          { text: 'Privacy', link: '/privacy' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: repo }
    ],

    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub'
    },

    footer: {
      message: 'Released under the AGPL-3.0 license. A fork of <a href="https://github.com/tiann/hapi">HAPI</a>. · <a href="/docs/privacy.html">Privacy</a>',
      copyright: 'Copyright © 2025-present dugong and HAPI contributors'
    },

    search: {
      provider: 'local'
    }
  },

  vite: {
    server: {
      allowedHosts: true
    }
  }
})
