# 功能图文手册

[简体中文](index.md) · [English](en/index.md)

从界面入口查操作方法。每个链接都能跳到对应说明，截图来自真实组件与演示数据，不包含真实 token、服务器会话或私有文件。

本手册覆盖 0.30.0 发布后的网页功能。1.0.0 尚未发布；开发截图中的版本号不代表可安装版本。尚未通过验收的历史滚动场景会在相关章节标注。

## 第一次使用

[连接并登录](start.md#connect) → [创建任务](tasks.md#create) → [发送要求](messages.md#send) → [批准操作](permissions.md#approve) → [检查改动](files.md#changes) → [审阅 PR](git.md#pr) → [完成并归档](tasks.md#archive)。

## 按功能查找

| 分类 | 可点击的功能说明 |
| --- | --- |
| [开始使用与界面导航](start.md) | [连接与登录](start.md#connect) · [认识桌面工作区](start.md#layout) · [手机访问与安装](start.md#phone) |
| [任务列表、状态与生命周期](tasks.md) | [查看和筛选任务](tasks.md#browse) · [创建新任务](tasks.md#create) · [把已有会话接为任务](tasks.md#adopt) · [启动、停止和切换状态](tasks.md#run) · [归档、恢复和删除](tasks.md#archive) |
| [worktree、分支与 PR](git.md) | [选择隔离方式](git.md#isolation) · [打开和刷新 PR](git.md#pr) · [查看运行历史](git.md#history) |
| [周期任务与定时消息](schedules.md) | [设置周期任务](schedules.md#task) · [暂停、恢复和立即运行](schedules.md#manage) · [安排一条消息稍后发送](schedules.md#message) |
| [会话创建、切换与管理](sessions.md) | [创建独立会话](sessions.md#new) · [切换会话与恢复工作](sessions.md#switch) · [会话菜单与导出](sessions.md#menu) |
| [消息输入、附件与阅读](messages.md) | [输入、发送与中止](messages.md#send) · [添加附件、路径与引用](messages.md#attachments) · [模型、推理强度和权限](messages.md#agent-options) · [查看工具结果、代码和历史](messages.md#read) |
| [审批与回答问题](permissions.md) | [批准或拒绝工具操作](permissions.md#approve) · [回答 agent 的选择题](permissions.md#answer) |
| [暂存清单与消息队列](scratchlist.md) | [添加、排序和删除暂存项](scratchlist.md#notes) · [放回输入框或加入队列](scratchlist.md#promote) |
| [复制、导出与图片分享](sharing.md) | [把一轮对话分享成图片](sharing.md#image) · [保存整段会话](sharing.md#export) |
| [任务助手、记忆与待答](assistant.md) | [打开助手并限定任务范围](assistant.md#chat) · [查看、新建和编辑记忆](assistant.md#memory) · [处理待答问题](assistant.md#questions) · [管理免确认操作](assistant.md#grants) |
| [工作区用户与目录范围](users.md) | [切换当前用户](users.md#switch) · [添加、改名与删除用户](users.md#manage) · [配置用户可见目录](users.md#paths) |
| [文件浏览、搜索与差异](files.md) | [查看暂存与未暂存改动](files.md#changes) · [目录浏览、搜索和排序](files.md#browse) · [阅读源码、Markdown 和 diff](files.md#preview) |
| [远程终端与命令输入](terminal.md) | [打开终端与连接检查](terminal.md#open) · [命令模式、直接模式与粘贴](terminal.md#input) |
| [设置：通用与会话摘要](settings-general.md) | [切换界面语言](settings-general.md#language) · [会话状态摘要](settings-general.md#summary) |
| [设置：外观、字体与会话显示](settings-display.md) | [选择外观和颜色主题](settings-display.md#theme) · [调整正文与终端字体](settings-display.md#fonts) · [调整会话列表和标题信息](settings-display.md#lists) |
| [设置：输入行为与工具条](settings-chat.md) | [设置回车行为](settings-chat.md#enter) · [排列、分组和隐藏输入栏工具](settings-chat.md#toolbar) · [工具卡片、思考过程与颜色](settings-chat.md#cards) |
| [设置：语音输入与语音助手](settings-voice.md) | [选择语音模式并连接](settings-voice.md#mode) · [配置语音服务凭据](settings-voice.md#credentials) · [选择声音并试听](settings-voice.md#voices) · [调整角色、说话方式与诊断](settings-voice.md#advanced) |
| [设置：设备名称与机器连接](settings-machines.md) | [查看和修改设备名称](settings-machines.md#name) · [机器不出现时如何处理](settings-machines.md#connect) |
| [设置：Git 托管凭据](settings-git.md) | [添加主机与 token](settings-git.md#add) · [检查、替换和移除凭据](settings-git.md#remove) |
| [设置：存储空间](settings-storage.md) | [查看数据库、WAL 与共享内存](settings-storage.md#read) |
| [设置：Token 用量](settings-usage.md) | [选择时间范围](settings-usage.md#range) · [理解缓存与分类统计](settings-usage.md#breakdown) |
| [设置：版本与项目入口](settings-about.md) | [查看版本并打开项目页面](settings-about.md#version) |
| [通知与离线使用](notifications.md) | [启用浏览器通知](notifications.md#browser) · [离线与多端使用](notifications.md#offline) |

## 找不到按钮时

| 现象 | 先检查 |
| --- | --- |
| 新任务没有可选机器 | runner 是否连接了同一 hub |
| 机器显示需要更新 | CLI/runner 是否支持当前界面能力 |
| 输入栏按钮不见了 | 聊天设置里的隐藏工具，以及当前 agent 支持范围 |
| 任务不在列表里 | 当前用户目录范围、任务状态和归档区域 |
| 看不到存储空间或 Token 用量 | 当前身份是否为 hub 所有者 |
| 语音功能不可用 | 服务凭据、HTTPS、麦克风权限与浏览器能力 |
| 手机上布局与图不同 | 手机使用单列与覆盖面板，入口以同名按钮为准 |

## 文档维护

按真实界面和源代码核对后更新截图；截图使用隔离的演示 API，不能改为连接真实生产数据。截图维护与功能入口清单见 [维护说明](maintaining.md)。
