---
name: add-feishu
description: Add Feishu/Lark as a channel. Supports both Feishu and Lark (enterprise) versions. Uses WebSocket long connection for real-time messaging.
---

# Add Feishu (Lark) Channel

This skill adds Feishu/Lark support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Are you using Feishu (feishu.cn) or Lark (lark.com)?

Options:
- Feishu (feishu.cn) - Most common for personal/ SMB use
- Lark (lark.com) - For enterprise users

Also ask:
- Do you have a Feishu/Lark application created in the developer console?

If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
```

This deterministically:
- Adds `src/channels/feishu.ts` (FeishuChannel class with self-registration via `registerChannel`)
- Appends `import './feishu.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu/Lark Application (if needed)

If the user doesn't have an app, tell them:

> Create a Feishu/Lark application:
>
> 1. Go to https://open.feishu.cn/ (Feishu) or https://open.lark.com/ (Lark)
> 2. Click "Create App" or "Create Enterprise App"
> 3. Fill in the app name and description
> 4. Note the App ID and App Secret

Wait for the user to provide the App ID and App Secret.

### Configure permissions

Tell the user:

> The app needs these permissions:
>
> **im.message.send_as_bot** - Send messages as bot
> **im.message.receive_as_bot** - Receive messages
>
> Go to App Configuration > Permissions > API Permissions and enable these.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=<their-app-id>
FEISHU_APP_SECRET=<their-app-secret>
FEISHU_DOMAIN=feishu  # or "lark" for enterprise version
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Configure Long Connection

### Enable long connection mode

Tell the user:

> **Important**: To receive messages in real-time, you need to enable long connection:
>
> 1. Go to your app in Feishu/Lark Developer Console
> 2. Go to **Events and Callbacks** (事件与回调)
> 3. Under **Subscription Method** (订阅方式), select **Receive events/callbacks through persistent connection** (使用长连接接收事件)
> 4. Add event: **im.message.receive_v1**
> 5. Click Save
>
> Note: The app must be running (NanoClaw service started) when you save, otherwise it will fail with "No connection detected".

### Start NanoClaw service first

If the service isn't running, start it first:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Then in the developer console, save the long connection settings.

## Phase 5: Registration

### Get Chat ID

When a user messages the bot, the chat will be automatically registered to `feishu_main` group.

The first message from a chat will trigger auto-registration.

### Verify registration

Check with:

```bash
sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'feishu:%'"
```

## Phase 6: Verify

### Test the connection

Tell the user:

> Send a message to your Feishu bot:
> - The bot should respond within a few seconds
> - The chat will be automatically registered on first message

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

You should see:
- `Feishu WebSocket long connection established`
- `Feishu message received`
- `Feishu message sent`

## Troubleshooting

### "No connection detected" when saving

The app must be running and connected before saving in the developer console. Start NanoClaw first, then save.

### Bot not responding

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Long connection is enabled in developer console
3. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Invalid timestamp errors

Make sure the app has the correct permissions:
- `im.message.receive_as_bot`

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove `FEISHU_APP_ID`, `FEISHU_APP_SECRET` from `.env`
4. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
