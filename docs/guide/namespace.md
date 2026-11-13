# Several people on one hub

A few people can share one hub and its machines. dugong has two ways to split it up, and they answer different questions.

| | Workspace users | Namespaces |
|---|---|---|
| Question | Whose work is this? | Who may see this at all? |
| Separates | What each person's task list, assistant and notifications show | Everything: sessions, tasks, machines |
| Shared token | Yes, everyone signs in with the same access token | No, each person has their own token suffix |
| Set up in | The web app | The token |

Most small teams want workspace users: everyone can still open anyone's task when needed, but each person's list shows their own work.

## Workspace users

A workspace user is a name and a set of directories. Any task or session running under one of those directories belongs to that user.

1. Open the user filter above the task list and choose Manage users.
2. Add a user for each person, and give each one the directories they work in, such as `/home/alice/code`. Browse on machine helps pick them.
3. Each person picks themselves in the filter, on each of their devices.

After that:

- the task and session lists show only that user's work; pick Everyone to see it all
- each person gets their own [task assistant](./tasks.md#the-task-assistant), with their own memory
- push notifications for a task go only to devices filtered to the user who owns it

A user with no directories sees an empty list rather than everything. Workspace users don't restrict access: anyone with the access token can switch the filter.

## Namespaces

A namespace walls off one person's sessions, tasks and machines from everyone else's on the same hub. Use it when people shouldn't see each other's work.

The hub keeps one base token. Each person appends `:<name>` to it:

```bash
# on the hub: the base token only
CLI_API_TOKEN="your-base-token"

# on Alice's machines, and when she signs in to the web app
CLI_API_TOKEN="your-base-token:alice"
```

Things to know:

- The hub refuses to start if its own token has a `:<name>` suffix.
- A machine belongs to one namespace. To run runners for two namespaces on one machine, give each its own `DUGONG_HOME`, or run `dugong auth logout` before switching, which also clears the machine ID.
- Telegram binding uses the same `base:name` token.
