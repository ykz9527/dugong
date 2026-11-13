# Install on your phone

dugong has no app store app. The web app can be installed from the browser instead, and then opens full screen from your home screen, with the same task list, chats and assistant as on your desktop.

Installing needs HTTPS: open the hub through the relay (`dugong hub --relay`), Tailscale with HTTPS, or your own reverse proxy. See [How it works](./how-it-works.md#reaching-the-hub-from-outside).

## Install

| Where | How |
|---|---|
| iPhone, iPad | Open the hub in Safari, tap Share, then Add to Home Screen |
| Android | Open the hub in Chrome or Edge, open the menu, then Install app or Add to Home screen |
| Desktop Chrome or Edge | Click the install icon in the address bar |

Sign in with your access token once; the installed app remembers it.

## Notifications

After you sign in, the app asks for permission to show notifications. Allow it to get a push when an agent asks for permission or finishes its turn. On iPhone, push only works in the installed app, not in a Safari tab. See [Notifications](./notifications.md).

## Updates

The app checks for a new version every hour and when you return to it. When there is one, a banner asks you to reload. It never reloads by itself, because an agent may be waiting for your answer or a message may be half written; the banner stays until you tap Reload.

## Offline

Without a connection the app shows the session list and messages it already loaded, with an Offline banner at the top. Actions don't queue up while you're offline: send them again once you're back.

## Share to dugong

On Android, the installed app appears in the system share sheet. Share text, a link, an image or a file to dugong, pick a session, and it lands in that session's composer.

## If something looks stale

The app caches its files. If it still shows an old version after an update, close it completely and open it again. If that doesn't help, clear the site data for the hub's address in the browser settings and sign in again.
