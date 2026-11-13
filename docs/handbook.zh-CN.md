# dugong 上手手册

需要按按钮查用法，请先看 [功能图文手册](manual/index.md)。本页保留部署与维护说明。

从零开始把 dugong 跑起来、用起来，以及踩过的坑。读完能独立操作。

英文 README 在 [README.md](../README.md)，改动清单在 [divergence.md](divergence.md)。

---

## 1. 这是什么

[HAPI](https://github.com/tiann/hapi) 的一个 fork，多了**任务**和**任务助手**：把 coding agent 当任务跑，写下要干的事，点开始，看任务自己走完 待办 → 运行中 → 待审阅；旁边每人一个助手，帮你盯着、记着、催着。

上游的能力全在——包住 Claude Code / Codex / Cursor 等 agent、浏览器和手机远程操作、离开电脑也能批准权限请求。

**跟官方 hapi 的关系**：代码从它 fork 来，但**不会合并回去**，也不共用数据。两者可以同时装、同时跑。

---

## 2. 五分钟跑起来

### 装

```bash
git clone https://github.com/ykz9527/dugong.git
cd dugong
bun install

# 构建单文件可执行程序（约 129MB，前端嵌在里面）
bun run download:tunwg          # 下载隧道二进制，只需一次
bun run build:web
(cd hub && bun run generate:embedded-web-assets)
(cd cli && bun run scripts/build-executable.ts --with-web-assets --name dugong)

cp cli/dist-exe/bun-linux-x64-baseline/dugong ~/.local/bin/dugong-bin
```

### 跟官方 hapi 隔离

dugong 默认用 `~/.dugong`，不碰官方的 `~/.hapi`。但两边默认都监听 3006，同机跑的话加一层 wrapper 换端口：

```bash
cat > ~/.local/bin/dugong <<'EOF'
#!/usr/bin/env bash
export DUGONG_LISTEN_PORT="${DUGONG_PORT:-3008}"
export DUGONG_API_URL="${DUGONG_API_URL:-http://localhost:$DUGONG_LISTEN_PORT}"
exec "$HOME/.local/bin/dugong-bin" "$@"
EOF
chmod +x ~/.local/bin/dugong
```

**别把 `DUGONG_HOME` 指到 `~/.hapi`。** 两边 v25 之后的迁移编号各指各的，dugong 打开上游的库会迁移出一个半残的 schema，官方 hapi 也再打不开它。

### 跑

```bash
dugong hub                                    # hub，:3008
dugong runner start --workspace-root ~/code   # runner，另一个终端
```

打开 `http://localhost:3008`，token 在 `~/.dugong/settings.json` 的 `cliApiToken`，hub 启动时也会打印。

`--workspace-root` 决定新建任务时目录选择器能翻到哪。不加就只能手敲路径。可以写多次开放多个根目录。

---

## 3. 手机远程

```bash
DUGONG_RELAY_FORCE_TCP=true dugong hub --relay
```

启动后打印公网地址（形如 `https://xxxxxxxx.relay.hapi.run`）和二维码。手机直接开那个地址，输 token。

**`DUGONG_RELAY_FORCE_TCP=true` 不能省**。默认走 UDP/WireGuard，在有 HTTP 代理的机器上（比如本地开着 clash 之类的代理）握手会一直超时：

```
lost connection to server
err: Post "https://relay.hapi.run/add": net/http: TLS handshake timeout
```

强制 TCP 就能穿过去。

### 用哪个地址

hub 日志里印的地址和二维码都直接指向隧道地址 `https://xxxxxxxx.relay.hapi.run/?token=...`，那是 dugong 自己的前端，有任务列表，扫码就能用。别开官方的 `app.hapi.run`，那里面没有任务列表。

（上游在 relay 模式下不服务静态资源，为的是省隧道带宽。这个 fork 改了：有自带前端就服务，没有才回退到官方提示页。见 `hub/src/web/server.ts` 的 `hasOwnFrontend`。）

### 启动后一堆 TLS 报错是正常的

```
[Tunnel] http: TLS handshake error from 142.93.78.230: EOF
[Tunnel] tls: client offered only unsupported versions: [302 301]
```

公网扫描器在探测。`302`/`301` 不是合法 TLS 版本号，ALPN 里塞 `http/0.9`、`spdy/1`——都是机器人指纹。日志级别是 INFO 不是 ERROR。它们连 TLS 都没握上，离 API 还远着。

真正要守的是 **token**——拿到它就能在你机器上开会话、跑命令。别贴进聊天记录、issue、截图。

---

## 4. 日常怎么用

### 任务

任务 = prompt + 工作目录 + agent。侧栏按六种状态分组：

| 状态 | 含义 |
|---|---|
| **待办** Backlog | 写下来了，没开始。新任务在这，可以直接开始 |
| **就绪** Ready | 跑过没成（取消 / 普通失败）。再点 Start |
| **运行中** Running | agent 在干活，或者在等它自己开的后台任务跑完 |
| **受阻** Blocked | 故障：session 死了、spawn 被拒、prompt 投不出去。得先解决外面的问题 |
| **待审阅** Review | turn 结束了，或者 agent 在等你批准、回答。详情面板里可以直接批准或拒绝 |
| **完成** Done | 你标的 |

**Ready 和 Blocked 的分界**：Ready 是"再点一次就可能成"，Blocked 是"不先处理点别的，Start 还是一样的结果"。

几条容易误解的规则：

- 进 Review 的触发是 **turn 结束**，不是进程退出。Claude Code 的 session 在 turn 之间一直活着，盯进程的话 Review 永远是空的。
- agent 留了 subagent 在后台，或者用 `await_background_task` 声明自己在等某个后台命令时，任务**扣在运行中**，等干完才放进待审阅。没声明的后台进程（比如留给你看的预览服务）不扣。
- **hub 重启不会打断 agent**，正在跑的任务最多回到就绪；待审阅的任务不会被动。

### 一个任务怎么收尾

`Review → Done → Archive`，照 agetor 的流程：

1. 待审阅的任务上点 **完成** —— 只改状态，不停会话、不动 worktree
2. 完成的任务上点 **归档**

归档有两道闸，都能显式绕过：

| 闸 | 报什么 | 绕法 |
|---|---|---|
| 只有完成的任务能归档 | `task_not_done` | `force: true` |
| run 还活着不能归档 | `task_running` | `stopRun: true` |

第二道在这里几乎必然撞上：Claude Code 的会话跨 turn 不退出，所以**每个待审阅 / 完成的任务都还攥着一个 `running` 的 run**。所以按钮会显示成「停止并归档」并要点两次——第一次是确认你真的要停掉 agent。

带 `stopRun` 归档时内部会先取消 run。取消本身的规则是把任务打回 `ready`（agetor 也一样），但那是"你主动停了它"的语义，不是"你归档了它"，所以这里会把状态恢复回归档前的值。Unarchive 回来还在 Done。

**别自己先点 Cancel 再标完成**——顺序反了，Cancel 会把你刚标好的 Done 拽回 Ready。用「停止并归档」一步到位。

#### 归档会替你收摊

归档不只是把任务藏起来，它还做两件事——照 agetor：

1. **停掉任务还挂着的会话。** 理由是任务一旦隐藏，界面上就再也够不着那个 agent 了，不在这里停就永远没机会停。这一条专治 `orphaned`：hub 重启后 run 记录已经结算，agent 却还在跑，`stopRun` 那道闸根本看不见它。
2. **删掉 worktree 的 checkout，回收磁盘。**

**分支和 commit 一律保留。** 归档是可逆的：`unarchive` 把任务叫回来，重新 start 时 runner 会在同一个确定性路径把 worktree 重建出来接上分支。删分支是 Delete 的活，那个才不可逆。

worktree 里有未提交改动时归档会**被拒绝**（`worktree_dirty`），任务留在原地——因为任务是你回到那个 worktree 的唯一入口，藏了就找不着了。按钮这时变成「仍然归档（N 处未提交）」，再点一次才真删。

不想删 checkout 就传 `keepWorktree: true`，会话照停。

**归档报「停不掉 agent」怎么办。** runner 重启后会丢掉它 spawn 过的进程的句柄（`resume-processes.json` 被清空），这时候归档会照常完成，但顶部会挂一条警告：进程还在跑，得手工结束。

```bash
ps -eo pid,cmd | grep dugong-bin   # 找 PID
readlink /proc/<pid>/cwd            # 确认是哪个任务的 worktree
kill <子 PID> <父 PID>
```

`orphaned` 状态的任务基本都会撞上这个——它就是 runner 重启的产物。

| 参数 | 作用 |
|---|---|
| `force` | 绕过"只有 Done 能归档" |
| `stopRun` | 绕过"run 还活着" |
| `forceWorktree` | 无视未提交改动，照样删 checkout |
| `keepWorktree` | 留着 checkout，只停会话 |

彻底删掉用 **Delete**：会拆 worktree，删分支用 `git branch -d` 从不用 `-D`（没合并的分支保留并报 `kept-unmerged`），worktree 里有未提交改动会拒绝并要 `force=true`。

### Sessions 页

设置 → 显示 → **「置顶进行中会话」**（默认关，手机上要单独开一次）。开了之后按状态分三段：

```
等你回话   有权限请求挂着 —— 你不动它就不动
在跑       thinking，或后台任务还没完
空闲       连着，但没事在跑
```

已结束的会话留在下面的项目分组里，按项目找。

### 多个任务改同一个仓库，会不会互相覆盖

**不会覆盖，但会"合干净了却是坏的"。** git 的行为分三种：

| 情况 | 结果 |
|---|---|
| 同文件不同区域 | 两边都保留 |
| 同文件同一行 | 冲突，git 拒绝自动合并 |
| 不同文件但语义相关 | **零冲突合并成功，运行时炸** |

第三种才是真风险。典型例子：任务 A 把 `getUser` 改名成 `fetchUser` 并改了它看得见的调用点，任务 B 从同一个 base 开出来、新建一个文件调用 `getUser`。合并输出干干净净，然后 `does not provide an export named 'getUser'`。没有任何冲突标记提醒你。

同类的还有：两个任务各加一个同版本号的 migration、都改了同一个共享常量的含义、一个改了函数签名另一个新增了旧签名的调用。

合并前把同一仓库上几个任务的改动对照着看一眼；改名、迁移编号、共享常量这类改动，最好让后合的那个任务先 rebase 再跑一遍测试。真正兜底的还是 CI。

### 接管已有的 claude 对话

终端里聊了一半，想转到手机上继续：

```bash
# 在项目目录里找会话 UUID
ls -t ~/.claude/projects/$(pwd | sed 's#/#-#g')/*.jsonl | head -5

dugong claude --resume <uuid>
```

上下文是真的接上（实测问它之前说过的口令词，答得出来）。两点注意：

- **必须带 UUID**。终端里 `claude --resume` 不带参数会进选择器，remote 模式不支持。
- 恢复的是 **Claude Code 的对话历史**，HAPI 侧是一条新 session。这样起的会话也会出现在任务列表里（每个会话都有一个任务）。没经过 dugong、用裸 `claude` / `codex` 开的对话，可以在「新建任务 → 接管已有会话」里收编成任务。

---

## 5. 改了代码怎么生效

**这是最容易踩的坑。**

前端是**构建二进制那一刻**打包进去的（`generate:embedded-web-assets` 把 `web/dist` 编成一个 TS 文件塞进可执行程序）。改了 `web/` 下的代码，重启 hub 没用，必须重新构建：

```bash
bun run build:web
(cd hub && bun run generate:embedded-web-assets)
(cd cli && bun run scripts/build-executable.ts --with-web-assets --name dugong)

# 正在跑的 hub 占着旧文件的 inode，直接 cp 会 "Text file busy"
mv ~/.local/bin/dugong-bin ~/.local/bin/dugong-bin.old
cp cli/dist-exe/bun-linux-x64-baseline/dugong ~/.local/bin/dugong-bin

# 重启 hub 才用上新的
```

只改了 `hub/` 或 `cli/` 的代码，可以跳过前两步，直接重新构建二进制。

手机上还要多一步：PWA 的 Service Worker 会缓存旧资源，光刷新可能不够，退出 PWA 重进或清站点数据。

想边改边看，用 dev 模式，不用反复构建：

```bash
cd hub && bun run src/index.ts    # :3006（或 DUGONG_LISTEN_PORT 指定）
cd web && bun run dev             # :5173，代理到 hub
```

---

## 6. 排查

| 现象 | 原因 |
|---|---|
| 点 Start 报 `RPC handler not registered: <id>:spawn-happy-session` | runner 不在（或刚重启没连上）。**只有开新会话需要 runner**，已有会话不受影响 |
| 任务永远卡在运行中出不去 | 会话是**官方 CLI** 起的。它不发 `background_tasks_changed`，hub 的后台任务计数只增不减。用仓库的 CLI |
| 隧道一直 `Waiting for trusted TLS certificate` | 少了 `DUGONG_RELAY_FORCE_TCP=true` |
| 手机上看不到任务列表 | 开的是 `app.hapi.run`（官方前端）。改开隧道地址本身 |
| 改了前端没变化 | 见第 5 节，要重新构建二进制 |
| 目录选择器翻不动 | runner 启动时没给 `--workspace-root` |
| 官方 hapi 起不来了 | `DUGONG_HOME` 指到了 `~/.hapi`，被 dugong 迁移过。从备份恢复 |
| 任务在运行中一直不动，进 chat 看 agent 从没收到任务 | prompt 投递竞态（已修）。旧版本里 spawn 一返回就发 prompt，可能早于 CLI 的 socket 连上，消息进空房间就没了 |
| 服务每 5 秒重启一次 | unit 的 `ExecStart` 指了 npm 的 Node 壳，不是真进程。见第 7 节 |
| Open PR 报 `git_host_no_token` | 没配 host token。Settings → Git hosts 加 `github.com`，classic PAT 要 `repo` scope |
| Open PR 报 `No commits between ...` | 分支和默认分支同一个 commit。agent 只是分析没改代码，或者改了没 commit |

### Open PR 需要同时满足四条

点一下会连做三件事：在**机器上** `git push` 分支 → 调 GitHub API 建 PR → 把 PR 缓存到任务上。先 push 是故意的，对远端没见过的分支建 PR，GitHub 会回一个很难懂的 422。

四条前置，缺一条就报对应的 code：

| 条件 | 缺了报什么 |
|---|---|
| 隔离方式是 `worktree`（`simple` 没有分支） | `task_no_branch` |
| 会话还在线（push 是借会话在机器上跑的） | `session_offline` |
| 配了该 host 的 token | `git_host_no_token` |
| 分支相对默认分支**有提交** | push 成功但建 PR 失败 |

最后一条最容易忽略：纯分析类的任务，agent 在对话里回答完就结束了，worktree 干干净净，没有可 PR 的东西。要 PR 就得在 chat 里让它把改动落下来并 commit。

token 存在 `$DUGONG_HOME/settings.json` 的 `gitHostTokens`（文件 0600），**不进数据库**。它只用于 GitHub API；`git push` 用的是机器上 git 自己的凭据链（比如 `gh auth setup-git` 配的 `gh auth git-credential`），两者互相独立，任何一边缺了都推不动。

### 判断一个会话到底活着没

**不要读数据库的 `sessions.active` 列。** 那一列只会被写 `false`（session 结束、keep-alive 超时两处），活着时的 `true` 只存在于 sync engine 的内存里。SQL 里唯一可靠的是 `s.active IS NULL`（LEFT JOIN 没匹配 = 行真的不存在）。

要问就问 `syncEngine.getSession(id)?.active`，或者走 API。

### 会话什么时候才会真的断

agent 是 detached 起的，不挂在任何监管进程下：

- 重启 hub → 照常干活
- 停掉 runner → 照常干活，还能继续对话
- 关浏览器 → 无影响

真会结束的只有：取消/删除任务、手动 kill、机器重启、agent 自己崩了。

---

## 7. 开机自启

用 systemd **用户级**服务托管 hub 和 runner，装在 `~/.config/systemd/user/`。示例：

```ini
# ~/.config/systemd/user/dugong-hub.service
[Unit]
Description=dugong hub

[Service]
EnvironmentFile=%h/.config/dugong.env
ExecStart=%h/.local/bin/dugong hub
Restart=always

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/dugong-runner.service
[Unit]
Description=dugong runner
After=dugong-hub.service

[Service]
EnvironmentFile=%h/.config/dugong.env
ExecStart=%h/.local/bin/dugong runner start-sync --workspace-root %h/code
KillMode=process
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dugong-hub dugong-runner
journalctl --user -u dugong-hub -f
```

用户级不是系统级，靠 **lingering** 在没人登录时也拉起来：

```bash
loginctl enable-linger $USER
```

### 三个坑

**1. env 文件不是可有可无的。** systemd 不走登录 shell，`.bashrc` 里的东西一样都到不了。必须在 `EnvironmentFile` 里重新声明两样：

- `PATH` —— runner 靠名字去 spawn `claude`、`git`。少了就 ENOENT，任务掉进受阻 而且错误信息没用。
- 代理 —— 如果机器要走代理才能连 `api.anthropic.com`，把 `https_proxy` 等写进去，agent 继承 runner 的环境。少了的话每个 agent 卡在第一次 API 调用上。

`no_proxy` 里留 localhost，runner 连本地 hub 才不会绕一圈。

**2. runner 必须用 `start-sync`，不是 `start`。** `start` 会 daemonize 然后返回，systemd 看见主进程退出就当服务挂了。`start-sync` 是同一个东西的前台版本。

**3. `ExecStart` 要指向真正的进程。** 如果你装的是 npm 版的命令，它是个 Node 壳，`execFileSync` 调真正的平台二进制然后干等着。systemd 记的 MainPID 是这个壳，`systemctl stop` 只杀壳，真 runner 活下来；下一次启动一看"已经有 runner 在跑"就退出 0，`Restart=always` 就变成每 5 秒一次的重启循环。用第 2 节那种 `exec` wrapper，或者直接指二进制。

### 为什么 runner 用 KillMode=process

agent 是 detached 起的，但 `setsid` 不会离开 cgroup。systemd 默认的 control-group kill 会在 runner 重启时把所有正在跑的 agent 一起带走——正好毁掉"停掉 runner，agent 照常干活"这个性质。`KillMode=process` 只杀 runner 本身。

hub 不需要这个，它反而应该连着 tunwg 一起干净退出。

### 日志里那条 inotify 报警

```
Failed to add control inotify watch descriptor ...: No space left on device
```

不是磁盘满，是 `fs.inotify.max_user_instances` 用光了。systemd 只是没法 watch cgroup，服务照常跑。要根治得 root 改 sysctl：

```bash
sudo sysctl -w fs.inotify.max_user_instances=512
```

---

## 8. 同步上游

```bash
git fetch upstream
git rebase upstream/main
bun install && bun run typecheck
cd hub && bun test && cd ../web && bun run test
git push --force-with-lease origin main
```

冲突面见 [divergence.md](divergence.md)。要盯的是 `cli/src/claude/utils/OutgoingMessageQueue.ts`——上游在积极维护那个消息转发闸门，而我们要放行的是一条**故意不可见**的系统消息，上游一改条件就会把它挡掉，**而且没有测试会失败**，只是后台任务扣留悄悄退化。

`cli` 的 `src/claude` 那套测试在上游 main 上本身就有约 10 个失败，别当成合并搞砸了——切到 `upstream/main` 跑一遍对照。
