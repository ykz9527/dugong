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
      { text: 'Manual / 图文手册', items: [
        { text: 'English', link: '/manual/en/' },
        { text: '简体中文', link: '/manual/' }
      ] },
      { text: 'Quick start', link: '/guide/quick-start' },
      { text: 'Releases', link: `${repo}/releases` }
    ],

    sidebar: [
      {
        text: 'Illustrated manual (English)',
        collapsed: true,
        items: [
          { text: 'Feature directory', link: '/manual/en/' },
          { text: "Getting started and navigation", link: '/manual/en/start' },
          { text: "Tasks, status and lifecycle", link: '/manual/en/tasks' },
          { text: "Worktrees, branches and pull requests", link: '/manual/en/git' },
          { text: "Recurring tasks and scheduled messages", link: '/manual/en/schedules' },
          { text: "Create and manage sessions", link: '/manual/en/sessions' },
          { text: "Write messages and read results", link: '/manual/en/messages' },
          { text: "Approve operations and answer questions", link: '/manual/en/permissions' },
          { text: "Scratchlist and message queue", link: '/manual/en/scratchlist' },
          { text: "Copy, export and share images", link: '/manual/en/sharing' },
          { text: "Task assistant, memory and questions", link: '/manual/en/assistant' },
          { text: "Workspace users and directory scope", link: '/manual/en/users' },
          { text: "Browse files, search and inspect diffs", link: '/manual/en/files' },
          { text: "Remote terminal and command input", link: '/manual/en/terminal' },
          { text: "Settings: language and session summaries", link: '/manual/en/settings-general' },
          { text: "Settings: appearance, fonts and session display", link: '/manual/en/settings-display' },
          { text: "Settings: input behavior and toolbar", link: '/manual/en/settings-chat' },
          { text: "Settings: dictation and voice assistant", link: '/manual/en/settings-voice' },
          { text: "Settings: machine names and connections", link: '/manual/en/settings-machines' },
          { text: "Settings: Git hosting credentials", link: '/manual/en/settings-git' },
          { text: "Settings: storage usage", link: '/manual/en/settings-storage' },
          { text: "Settings: token usage", link: '/manual/en/settings-usage' },
          { text: "Settings: versions and project links", link: '/manual/en/settings-about' },
          { text: "Notifications and offline use", link: '/manual/en/notifications' },
        ]
      },
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
