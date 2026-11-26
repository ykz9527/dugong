# Deployment

How to keep the hub and runner running after you close the terminal or reboot, and how to reach the hub from outside your network.

## Start at boot

dugong doesn't install a service for you. Pick the service manager your system already uses. Whichever you choose, keep these in mind:

- Run the runner with `dugong runner start-sync`. `dugong runner start` detaches and exits, and a service manager reads that as a crash.
- Point the service at the real `dugong` binary. The npm package installs a small Node launcher that starts the binary and waits; if the service manager tracks the launcher, stopping the service leaves the runner behind, and the next start sees a runner already running and exits. Use a [release binary](https://github.com/ykz9527/dugong/releases), or the binary npm installed in the platform package: `$(npm root -g)/@ykz9527/dugong/node_modules/@ykz9527/dugong-linux-x64/bin/dugong` on 64-bit Linux (`dugong-darwin-arm64` on Apple silicon).
- Services don't read your shell profile. Give them the `PATH` that finds `claude`, `codex` and `git`, and any proxy variables the agents need to reach their providers. Without them, agents fail to start and their tasks go to Blocked.
- Set `DUGONG_RUNNER_SUPERVISED=1` on the runner. It tells dugong that a supervisor will start the runner again: the web app's Restart button can then stop it safely, and when the `dugong` binary is replaced the runner exits and lets the supervisor start the new one. Without it, the runner hands over to a detached copy of itself, which runs outside the service; systemd then restarts the service every few seconds because each new start finds a runner already running.

### Linux: systemd

User services, in `~/.config/systemd/user/`. First an environment file, `~/.config/dugong.env`:

```ini
PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin
# https_proxy=http://127.0.0.1:7890
# no_proxy=localhost,127.0.0.1
```

`dugong-hub.service`:

```ini
[Unit]
Description=dugong hub
After=network-online.target

[Service]
EnvironmentFile=%h/.config/dugong.env
ExecStart=%h/.local/bin/dugong hub
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

`dugong-runner.service`:

```ini
[Unit]
Description=dugong runner
After=dugong-hub.service

[Service]
EnvironmentFile=%h/.config/dugong.env
Environment=DUGONG_RUNNER_SUPERVISED=1
ExecStart=%h/.local/bin/dugong runner start-sync --workspace-root %h/code
KillMode=process
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dugong-hub dugong-runner
journalctl --user -u dugong-hub -f
loginctl enable-linger $USER      # keep them running when you're logged out
```

`KillMode=process` matters. Agents are started detached, but they stay in the runner's cgroup, and systemd's default stops everything in that cgroup when the unit stops. With `KillMode=process`, restarting or upgrading the runner leaves running agents alone, and the new runner picks them up.

### macOS: launchd

dugong doesn't create these files; the labels below are only a suggestion. Save as `~/Library/LaunchAgents/com.dugong.hub.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dugong.hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/dugong</string>
        <string>hub</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/you/.dugong/logs/hub.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/.dugong/logs/hub.log</string>
</dict>
</plist>
```

And `~/Library/LaunchAgents/com.dugong.runner.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dugong.runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/dugong</string>
        <string>runner</string>
        <string>start-sync</string>
        <string>--workspace-root</string>
        <string>/Users/you/code</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>DUGONG_RUNNER_SUPERVISED</key>
        <string>1</string>
    </dict>
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>65536</integer>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/you/.dugong/logs/runner.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/.dugong/logs/runner.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.dugong.hub.plist
launchctl load ~/Library/LaunchAgents/com.dugong.runner.plist
```

macOS may suspend background work while the display sleeps. If agents stall overnight, keep the machine awake with `caffeinate -dimsu` in a separate terminal.

### pm2

If you already use pm2:

```bash
pm2 start "dugong hub" --name dugong-hub
DUGONG_RUNNER_SUPERVISED=1 pm2 start "dugong runner start-sync --workspace-root ~/code" --name dugong-runner
pm2 save
pm2 startup      # prints the command that starts pm2 at boot
```

## Reach the hub from outside

### The relay

```bash
dugong hub --relay
```

The hub opens a tunnel through `relay.hapi.run`, a relay server run by the HAPI project, and prints a public HTTPS address and a QR code. Traffic is end-to-end encrypted with WireGuard and TLS, so the relay can't read it. The relay is off unless you pass `--relay`; `--no-relay` turns it off explicitly.

The tunnel uses UDP. Behind a proxy or a network that blocks UDP, the handshake times out; set `DUGONG_RELAY_FORCE_TCP=true` to use TCP instead.

The first time, the relay issues the hub its own key, which the hub saves as `relayAuthKey` in `settings.json`. If the relay rejects a saved key, the hub asks for a new one. The relay limits how many keys one public IP can get, so many hubs behind one office address may hit HTTP 429. `DUGONG_RELAY_AUTH` overrides the key, and `DUGONG_RELAY_API` points the hub at a different relay server.

### Tailscale

```bash
sudo tailscale up
DUGONG_LISTEN_HOST=0.0.0.0 dugong hub
```

Open `http://100.x.x.x:3006` from any device on your tailnet.

### Cloudflare Tunnel

Use a named tunnel. Quick tunnels (TryCloudflare) don't support server-sent events, which the web app needs for live updates.

```bash
cloudflared tunnel create dugong
cloudflared tunnel route dns dugong dugong.example.com
cloudflared tunnel --protocol http2 run dugong
```

`--protocol http2` avoids timeouts on the long-lived event stream that the default QUIC protocol can cause.

### Reverse proxy

Put Caddy or Nginx with HTTPS in front of the hub, and set `DUGONG_PUBLIC_URL` to the public address so notification links point there. Browsers only allow push notifications and installing the web app over HTTPS.

If runners on other machines reach the hub through HTTPS with a private certificate authority, trust it with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
