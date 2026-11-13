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
      { text: '图文手册', link: '/manual/' },
      { text: 'Quick start', link: '/guide/quick-start' },
      { text: 'Releases', link: `${repo}/releases` }
    ],

    sidebar: [
      {
        text: '功能图文手册',
        collapsed: false,
        items: [
          { text: '功能目录与操作路线', link: '/manual/' },
          { text: '开始使用与界面导航', link: '/manual/start' },
          { text: '任务列表、状态与生命周期', link: '/manual/tasks' },
          { text: 'worktree、分支与 PR', link: '/manual/git' },
          { text: '周期任务与定时消息', link: '/manual/schedules' },
          { text: '会话创建、切换与管理', link: '/manual/sessions' },
          { text: '消息输入、附件与阅读', link: '/manual/messages' },
          { text: '审批与回答问题', link: '/manual/permissions' },
          { text: '暂存清单与消息队列', link: '/manual/scratchlist' },
          { text: '复制、导出与图片分享', link: '/manual/sharing' },
          { text: '任务助手、记忆与待答', link: '/manual/assistant' },
          { text: '工作区用户与目录范围', link: '/manual/users' },
          { text: '文件浏览、搜索与差异', link: '/manual/files' },
          { text: '远程终端与命令输入', link: '/manual/terminal' },
          { text: '设置：通用与会话摘要', link: '/manual/settings-general' },
          { text: '设置：外观、字体与会话显示', link: '/manual/settings-display' },
          { text: '设置：输入行为与工具条', link: '/manual/settings-chat' },
          { text: '设置：语音输入与语音助手', link: '/manual/settings-voice' },
          { text: '设置：设备名称与机器连接', link: '/manual/settings-machines' },
          { text: '设置：Git 托管凭据', link: '/manual/settings-git' },
          { text: '设置：存储空间', link: '/manual/settings-storage' },
          { text: '设置：Token 用量', link: '/manual/settings-usage' },
          { text: '设置：版本与项目入口', link: '/manual/settings-about' },
          { text: '通知与离线使用', link: '/manual/notifications' },
        ]
      },
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
