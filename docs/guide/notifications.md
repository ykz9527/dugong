# Notifications

dugong tells you when an agent asks for permission, when its turn ends and it waits for you, and when a background task it started finishes or fails. Push notifications work without any setup. Telegram and ServerChan are optional.

## Push

After you sign in, the web app asks the browser for permission to show notifications. Allow it, and the hub sends push messages to that browser, or to your phone if you [installed the web app there](./pwa.md).

The hub signs push messages with its own VAPID keys, which it generates on first run and keeps in `~/.dugong`. The messages travel through your browser vendor's push service, such as Google's for Chrome or Apple's for Safari. No dugong or HAPI server is involved.

Push needs HTTPS, or `localhost`. Over the relay or behind a reverse proxy with HTTPS it works; over plain `http://192.168.x.x:3006` the browser refuses.

When several people share a hub, a device only gets notifications for the work of the user it is filtered to. See [Several people on one hub](./namespace.md).

If you never get a notification, check the browser's site settings for the hub's address, and on Android turn off battery optimisation for the browser or the installed app.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Start the hub with the token and its public HTTPS address:

   ```bash
   export TELEGRAM_BOT_TOKEN="123456:ABC..."
   export DUGONG_PUBLIC_URL="https://your-hub.example.com"
   dugong hub
   ```

3. Send `/start` to your bot, open the app it offers, and sign in with your access token.

The bot then sends you a message when an agent is ready or asks for permission, with Allow and Deny buttons for permission requests and a button that opens the session. The app opens inside Telegram, which requires `DUGONG_PUBLIC_URL` to be HTTPS and reachable from the internet; the relay address works.

Set `TELEGRAM_NOTIFICATION=false` to keep the bot without its notifications.

## ServerChan

[ServerChan (Server酱)](https://sct.ftqq.com/) forwards messages to WeChat and other apps.

```bash
export SERVERCHAN_SENDKEY="SCT..."
export DUGONG_PUBLIC_URL="https://your-hub.example.com"
dugong hub
```

Each message links back to the session through `DUGONG_PUBLIC_URL`. Two switches control it:

| Variable | Default | Effect |
|---|---|---|
| `SERVERCHAN_NOTIFICATION` | `true` | Set to `false` to turn ServerChan messages off |
| `SERVERCHAN_BACKGROUND_ONLY` | `false` | Send only when no dugong page is open and visible, so ServerChan covers the time you're away |

All of these can also go in `~/.dugong/settings.json` as `telegramBotToken`, `serverChanSendKey` and so on; see [Installation](./installation.md#hub-settings).
