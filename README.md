# movie-money

A Telegram bot that hands out movies by short numeric code, gated behind mandatory channel subscriptions — built with NestJS, grammY, Prisma and PostgreSQL.

Admins forward a video into the bot and assign it a 1–4 digit code. Users send that code in a private chat and get the video back, but only after the bot has verified they are subscribed to every channel currently marked as required. The bot's user-facing copy is written in Uzbek; the codebase and this document are in English.

> **Status:** MVP. It runs in production behind PM2, but expect rough edges — see [Known issues](#known-issues).

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Database](#database)
- [Prerequisites](#prerequisites)
- [Setup and installation](#setup-and-installation)
- [Configuration](#configuration)
- [Running locally](#running-locally)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Project structure](#project-structure)
- [Known issues](#known-issues)
- [Contributing](#contributing)
- [License](#license)

---

## Features

Everything listed here is implemented in `src/`.

### For users

- **`/start`** — registers the sender in the `users` table (or refreshes a changed username), runs the subscription check, and shows a greeting plus the 10 most recently added movies with their codes.
- **Movie lookup by code** — any 1–4 digit message is looked up in the `movies` table and, on a hit, the video is sent back with a caption. Anything that isn't 1–4 digits gets a format error.
- **Forced channel subscription** — before a lookup succeeds, the bot calls `getChatMember` for every enabled row in `required_channels`. Users with status `left` or `kicked` are shown an inline keyboard of join links plus a "✅ Tasdiqlash" (confirm) button that re-runs the check.
- **Forward protection** — delivered videos are sent with `protect_content: true`, so recipients cannot forward or save them.
- **Request logging** — every successful delivery writes a row to `requests` (user id + movie code + timestamp).

### For admins

- **`/admin`** — opens an inline-keyboard admin panel. Non-admins get silence, not an error message.
- **Movie management** — add a movie (forward it from the source channel, or send a video/document, then reply with a 1–4 digit code), remove a movie by code, and list the 10 most recent movies.
- **Channel management** — add a required channel by username (the bot resolves it via `getChat` and stores the numeric id), remove one by username, and list all enabled required channels.
- **Admin management** *(super admins only)* — add an admin by Telegram user id, remove an admin by id, and list all admins. Super admins come from the `SUPER_ADMIN_IDS` environment variable and cannot be removed through the bot.
- **`/broadcast <text>`** — sends a message to every row in `users`, throttled to one message every 200 ms, with a 5 s back-off when Telegram returns `Too Many Requests`. Progress and a success/failure tally are logged and reported back to the sender. An optional video attachment is supported (see [Known issues](#known-issues)).

---

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 20+ | The deploy workflow pins Node 20. |
| Language | TypeScript 5 | `commonjs`, target `ES2021`, decorators enabled. |
| Framework | NestJS 10 | `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`. |
| Compiler | SWC | Configured via `nest-cli.json` (`"builder": "swc"`). |
| Telegram client | [grammY](https://grammy.dev) 1.x | Long polling (`bot.start()`), not webhooks. |
| ORM | Prisma 6 | `@prisma/client` + `prisma` CLI. |
| Database | PostgreSQL | Set by the `postgresql` datasource provider. |
| Logging | winston 3 | Single colorised console transport. |
| Tests | Jest 29 + Supertest | Unit config in `package.json`, e2e config in `test/jest-e2e.json`. |
| Lint/format | ESLint 8 + Prettier 3 | `eslint-config-prettier`, `eslint-plugin-prettier`. |
| Process manager | PM2 | Used by the deploy workflow on the target server. |

---

## Architecture

The app is a standard NestJS application whose HTTP server is essentially vestigial — the real work happens in a grammY long-polling loop started during module initialisation.

```
main.ts  →  AppModule  →  BotModule  →  DatabaseModule
                              ├── BotService        (grammY bot, all handlers)
                              ├── BroadcastService  (fan-out to all users)
                              └── BroadcastHandler  (/broadcast command)
```

### `src/main.ts`

Bootstraps the Nest application and listens on `process.env.PORT ?? 3000`. Nothing else — the port exists so the process has an HTTP surface (useful for uptime checks and PM2).

### `src/app.module.ts`, `app.controller.ts`, `app.service.ts`

The root module. It imports `BotModule` and registers a single `GET /` route that returns `Hello World!` via `AppService`. This is the untouched Nest scaffold and doubles as a health endpoint.

### `src/modules/database` — `DatabaseModule` / `DatabaseService`

`DatabaseService` extends `PrismaClient` and implements `OnModuleInit`, calling `$connect()` when the module starts. It is provided and exported by `DatabaseModule`, so any module that imports `DatabaseModule` gets a single shared, connected Prisma client. `getClient()` returns `this` for callers that want the plain client type.

### `src/modules/bot` — `BotModule`

Imports `DatabaseModule` and provides/exports `BotService`, `BroadcastService` and `BroadcastHandler`.

#### `BotService` (`bot.service.ts`)

The core of the project. It constructs the grammY `Bot` from `BOT_TOKEN`, installs middleware, and on `onModuleInit()` registers handlers and starts long polling.

- **Middleware** — logs the `chatId` of every incoming update, and installs `bot.catch` so handler errors are logged instead of crashing the process.
- **Handlers** — `/start`, `/admin`, a catch-all `callback_query` handler, and a catch-all `message` handler. `/broadcast` is registered separately by `BroadcastHandler` through `registerBroadcastCommand()`.
- **Admin sessions** — an in-memory `Map<number, AdminSession>` tracks whether a user is in admin mode and which input the bot is currently waiting for (`awaitingMovieCode`, `awaitingNewAdminId`, `awaitingChannelInfo`, `awaitingChannelRemoval`, `awaitingAdminRemoval`, `awaitingMovieRemoval`) plus any `pendingMovie`. Because this is process memory, **restarting the bot clears all admin sessions**.
- **Message routing** — `handleMessage` checks the session: admins in admin mode go to `handleAdminMessage` (which dispatches on the awaiting-flags, then falls through to treating a forward from `CHANNEL_UZ_ID`, a video or a document as a movie upload); everyone else goes to `handleRegularUserMessage`, which enforces the subscription gate and then looks up the code.
- **Authorisation** — `superAdminIds` is parsed once at construction from `SUPER_ADMIN_IDS`: the value is split on commas, each part is coerced with `Number()`, and anything that isn't a non-zero integer is discarded. `isSuperAdmin()` tests membership in that list; `isAdmin()` returns true for super admins *or* for any row in the `admins` table. Super-admin-only callbacks (`admin_management`, `add_admin`, `remove_admin_user`, `list_admins`) return `null` for everyone else.
- **UI** — `safeReply()` edits the existing message when the update is a callback query and falls back to a fresh reply when Telegram refuses the edit; `getMenuKeyboard()` and `getBackKeyboard()` build the inline keyboards.
- **Subscription gate** — `checkChannelSubscriptions()` iterates enabled `required_channels`. `chat not found` and `user not found` errors are treated as "not subscribed" (fail closed); other API errors are logged and skipped (fail open) so a transient outage doesn't lock everyone out.

#### `BroadcastService` (`broadcast/broadcast.service.ts`)

Pulls every user from the database and sends them the broadcast payload sequentially, sleeping 200 ms between sends. When a video path is supplied it uploads the file once to the first super admin to obtain a reusable `file_id`, then sends that id to everyone (falling back to per-user stream uploads if the initial upload fails). Returns `{ success, failed }` counts and logs throughput every 30 s or every 100 users. Its `adminIds` list is parsed from `SUPER_ADMIN_IDS` with the same logic `BotService` uses.

#### `BroadcastHandler` (`broadcast/broadcast.handler.ts`)

On `onModuleInit()` it registers itself as the `/broadcast` command handler on `BotService`'s bot instance. It checks the sender against `BroadcastService.adminIds` and returns early if they aren't listed, parses the message text into a body and an optional video filename, calls `sendBroadcastToAllUsers` with `Markdown` parse mode, and replies with the resulting statistics.

### `src/shared/utils/logger.ts`

A winston logger at `info` level with a JSON base format and one colorised, timestamped console transport. Imported directly (default export) wherever logging is needed rather than through Nest DI.

---

## Database

PostgreSQL, accessed through Prisma. The schema lives in [`prisma/schema.prisma`](prisma/schema.prisma); all models use `uuid()` string primary keys and `@@map` to snake_case table names.

### Models

#### `User` → `users`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String` | PK, `uuid()` |
| `username` | `String?` | Telegram username, kept in sync on `/start` |
| `telegramId` | `Float` | **Unique.** Telegram user id |
| `joinedAt` | `DateTime?` | `@default(now())`, column `joined_at` |

Every person who sends `/start` is stored here. This table is also the broadcast audience.

#### `Admin` → `admins`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String` | PK, `uuid()` |
| `userId` | `String` | **Unique.** Telegram user id as a string, column `user_id` |
| `createdAt` | `DateTime` | `@default(now())`, column `created_at` |
| `isActive` | `Boolean` | `@default(true)`, column `is_active` |
| `Movie` | `Movie[]` | Back-relation of `Movie.admin` |

Database-backed admins. Super admins are *not* stored here — they come from `SUPER_ADMIN_IDS`.

#### `Movie` → `movies`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String` | PK, `uuid()` |
| `code` | `String` | **Unique.** The 1–4 digit code users send |
| `title` | `String` | First line of the upload caption, or `Unknown Movie` |
| `fileId` | `String` | Telegram `file_id`, column `file_id` |
| `addedBy` | `String` | FK → `Admin.id`, column `added_by` |
| `admin` | `Admin` | Relation on `addedBy` |
| `createdAt` | `DateTime` | `@default(now())`, column `created_at` |
| `expiresAt` | `DateTime?` | Column `expires_at`. Present in the schema; no expiry logic is implemented yet |

#### `RequiredChannel` → `required_channels`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String` | PK, `uuid()` |
| `channelId` | `String` | **Unique.** Numeric channel id resolved via `getChat` |
| `username` | `String` | **Unique.** Channel username without `@` |
| `enabled` | `Int` | `@default(1)`. Only rows with `enabled = 1` are enforced |

#### `Request` → `requests`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String` | PK, `uuid()` |
| `userId` | `String` | Telegram user id as a string, column `user_id`, indexed |
| `code` | `String` | Requested movie code, indexed |
| `timestamp` | `DateTime?` | `@default(now())` |

An append-only delivery log. Note it stores a raw Telegram id rather than a foreign key to `User`, so there is no relation between the two.

### Relationships

```
Admin 1 ──< Movie          (Movie.addedBy → Admin.id, onDelete: Restrict)
User        (no relations — Request stores a bare Telegram id, not an FK)
RequiredChannel (standalone)
```

`Movie.admin` uses the Prisma default `onDelete: Restrict`, so an `Admin` row that owns movies cannot be deleted while those movies exist.

### Migration workflow

Migrations live in `prisma/migrations/` and are committed to the repository. Three exist today:

| Migration | What it does |
| --- | --- |
| `20250604170028_tables_added` | Creates `users`, `admins`, `movies`, `required_channels`, `requests`, their unique/regular indexes, and the `movies → admins` foreign key |
| `20250604170652_tables_added` | Adds `DEFAULT CURRENT_TIMESTAMP` to `users.joined_at` |
| `20250609055507_add_admin_system` | Adds `admins.created_at` and `admins.is_active` |

Common commands (there are no npm aliases for these — call the Prisma CLI directly):

```bash
# Generate the Prisma client after a schema change or a fresh install
npx prisma generate

# Development: create + apply a new migration from schema changes
npx prisma migrate dev --name your_migration_name

# Apply committed migrations without generating new ones (CI / production)
npx prisma migrate deploy

# Inspect current migration state
npx prisma migrate status

# Browse the data
npx prisma studio
```

> The deploy workflow runs `npx prisma generate` but **not** `npx prisma migrate deploy`. Migrations must currently be applied to production by hand.

---

## Prerequisites

- **Node.js 20 or newer** and npm.
- **PostgreSQL 13+**, either local or remote, with a database you can point `DATABASE_URL` at.
- **A Telegram bot token** from [@BotFather](https://t.me/BotFather).
- **Your own Telegram user id**, for `SUPER_ADMIN_IDS`. Any "what is my id" bot will tell you, or start the app and read the `user chatId: <id>` line the middleware logs for every update.
- **A Telegram channel or group to serve as the movie source**, with the bot added as an administrator (needed so the bot can resolve forwards and read channel messages).
- **Administrator rights for the bot in every required channel**, otherwise `getChatMember` fails and the subscription gate cannot verify anyone.

---

## Setup and installation

```bash
# 1. Clone
git clone https://github.com/dostonsulaymon/movie-money.git
cd movie-money

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env
#    then edit .env and fill in BOT_TOKEN, DATABASE_URL,
#    SUPER_ADMIN_IDS and CHANNEL_UZ_ID

# 4. Create the database schema
npx prisma migrate deploy   # or: npx prisma migrate dev

# 5. Generate the Prisma client
npx prisma generate
```

Put your own Telegram user id in `SUPER_ADMIN_IDS` before the first run — it is the only way to bootstrap access. Once you are a super admin you can add ordinary admins from the `/admin` panel without touching configuration again.

---

## Configuration

Every variable the code actually reads:

| Variable | Required | Default | Read by | Description |
| --- | --- | --- | --- | --- |
| `BOT_TOKEN` | **Yes** | `''` | `src/modules/bot/bot.service.ts` | Telegram bot token from @BotFather. Falls back to an empty string, which makes grammY fail on startup — so treat it as mandatory. |
| `DATABASE_URL` | **Yes** | — | `prisma/schema.prisma` | PostgreSQL connection string used by both the Prisma CLI and the runtime client. |
| `SUPER_ADMIN_IDS` | **Yes** | `''` (empty list) | `src/modules/bot/bot.service.ts`, `src/modules/bot/broadcast/broadcast.service.ts` | Comma-separated Telegram user ids granted super-admin rights. Parsed with `Number()` per entry; anything that is not a non-zero integer is silently discarded. **Fails closed** — see below. |
| `CHANNEL_UZ_ID` | No | `undefined` | `src/modules/bot/bot.service.ts` | Numeric id of the source channel. A message an admin forwards from this chat is treated as a movie upload. With it unset, admins can still upload by sending a video or document directly. |
| `PORT` | No | `3000` | `src/main.ts` | Port for the NestJS HTTP server. |

### `SUPER_ADMIN_IDS` fails closed

If `SUPER_ADMIN_IDS` is unset, empty, or contains nothing that parses to a non-zero integer, **the bot has no super admins at all**. The consequences are deliberate and total:

- Admin management (add/remove/list admins) is unreachable for everyone.
- `/broadcast` rejects every sender.
- On a fresh database the `admins` table is empty, so `/admin` silently does nothing for every user — and because the only way to create an admin is through the super-admin panel, **there is no in-bot path to recover**. You must set the variable and restart.

The value is read once when the service is constructed, so changing it requires a restart. Treat it as required configuration, not an optional hardening step.

The deploy workflow additionally consumes five **GitHub Actions secrets** — `SERVER_HOST`, `SERVER_USER`, `SERVER_SECRET`, `SERVER_PORT`, `DEPLOY_PATH` — which are not application environment variables. See [CI/CD](#cicd).

> **Gotcha:** the application does not register `@nestjs/config` or `dotenv`. The Prisma CLI reads `.env` on its own, but `npm run start` will *not* pick your `.env` up automatically. Export the variables into the process environment first:
>
> ```bash
> set -a; source .env; set +a
> npm run start:dev
> ```
>
> In production, PM2 (or your process manager of choice) should supply them.

---

## Running locally

All scripts are defined in `package.json`.

| Command | What it does |
| --- | --- |
| `npm run start` | Start the app once (`nest start`) |
| `npm run start:dev` | Start in watch mode |
| `npm run start:debug` | Start in watch mode with the Node inspector attached |
| `npm run build` | Compile to `dist/` via `nest build` (SWC) |
| `npm run start:prod` | Run the compiled build (`node dist/main`) |
| `npm run lint` | ESLint over `src`, `apps`, `libs`, `test` with `--fix` |
| `npm run format` | Prettier over `src/**/*.ts` and `test/**/*.ts` |

Typical development loop:

```bash
set -a; source .env; set +a
npm run start:dev
```

The bot uses **long polling**, so only one instance may run against a given token at a time. If a production instance is live, stop it before starting a local one or Telegram will return a conflict.

---

## Testing

| Command | What it does |
| --- | --- |
| `npm test` | Jest unit tests — `rootDir: src`, matches `*.spec.ts` |
| `npm run test:watch` | Jest in watch mode |
| `npm run test:cov` | Coverage report into `coverage/` |
| `npm run test:debug` | Jest under the Node inspector, `--runInBand` |
| `npm run test:e2e` | Jest with `test/jest-e2e.json`, matches `*.e2e-spec.ts` |

**Current coverage is minimal and honestly reported:** there are no `*.spec.ts` files in `src/`, and the only e2e test is `test/app.e2e-spec.ts`, which boots `AppModule` and asserts `GET /` returns `Hello World!`. Because booting `AppModule` also boots `BotModule`, that test needs a valid `BOT_TOKEN` and a reachable `DATABASE_URL` to pass. Meaningful tests for `BotService` are the most valuable contribution this repo could receive.

---

## CI/CD

One workflow: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**Triggers:** every push to `main`, plus manual `workflow_dispatch` from the GitHub UI.

**`build` job:** present but **entirely commented out**. It would check out the code, set up Node 20 with npm caching, run `npm ci`, `npx prisma generate`, `npm run build` and `npm test` (with `continue-on-error`). Nothing currently validates a push before it is deployed.

**`deploy` job:** the only active job. It runs on `ubuntu-latest` and uses [`appleboy/ssh-action@v1.0.3`](https://github.com/appleboy/ssh-action) to open an SSH session against the target server, then runs a deploy script over it.

It requires five repository secrets:

| Secret | Purpose |
| --- | --- |
| `SERVER_HOST` | Hostname or IP of the deploy target |
| `SERVER_USER` | SSH username |
| `SERVER_SECRET` | SSH password for that user |
| `SERVER_PORT` | SSH port |
| `DEPLOY_PATH` | Absolute path of the checkout on the server; the script `cd`s here first |

The script then runs, in order:

1. `git pull origin main`
2. `npm ci --production`
3. `npx prisma generate`
4. `npm run build`
5. `pm2 reload <app>` — falling back to `pm2 start dist/main.js --name <app>` on first deploy
6. `pm2 save`, then `pm2 status`

Two things to be aware of if you fork this:

- Authentication is **password-based over SSH**. A deploy key or SSH key pair would be a meaningful improvement.
- The pipeline **never runs `prisma migrate deploy`**, so schema changes do not reach production automatically.

---

## Project structure

```
src/
├── app.controller.ts            # GET / → "Hello World!" (health endpoint)
├── app.module.ts                # Root module; imports BotModule
├── app.service.ts               # Trivial service behind AppController
├── main.ts                      # Nest bootstrap; listens on PORT ?? 3000
├── modules/
│   ├── bot/
│   │   ├── bot.module.ts        # Wires BotService + broadcast providers
│   │   ├── bot.service.ts       # grammY bot: commands, callbacks, admin panel,
│   │   │                        #   movie CRUD, channel CRUD, subscription gate
│   │   └── broadcast/
│   │       ├── broadcast.handler.ts  # /broadcast command, arg parsing, auth
│   │       └── broadcast.service.ts  # Fan-out to all users, rate limiting
│   └── database/
│       ├── database.module.ts   # Provides + exports DatabaseService
│       └── database.service.ts  # PrismaClient subclass, connects on init
└── shared/
    └── utils/
        └── logger.ts            # winston logger (console transport)

prisma/
├── schema.prisma                # Datasource, generator, 5 models
└── migrations/                  # 3 committed migrations + migration_lock.toml

test/
├── app.e2e-spec.ts              # Boots AppModule, asserts GET /
└── jest-e2e.json                # e2e Jest config

.github/
└── workflows/
    └── deploy.yml               # SSH + PM2 deploy on push to main
```

---

## Known issues

Documented rather than hidden, because they will bite you.

### `BroadcastService` does not enforce its own authorisation check

`sendBroadcastToAllUsers()` opens with a membership test against `adminIds`, but the failing branch only logs a warning — it does not `return`:

```ts
if (!this.adminIds.includes(senderId)) {
  logger.warn(`Unauthorized broadcast attempt by user ${senderId}`);
}
// execution continues; the broadcast is sent regardless
```

The only effective authorisation gate is the early `return` in `BroadcastHandler.handleBroadcastCommand()`, which runs before the service is called. That protects the `/broadcast` command as it exists today, but the service itself is unguarded: any new caller — an HTTP route, a scheduled job, another handler — would send a broadcast to every registered user with no permission check. The service should fail closed on its own.

### Other rough edges

- **Admin state is in-memory.** Restarting the process drops every open admin session and any half-finished movie upload.
- **`SUPER_ADMIN_IDS` is read once at construction.** Changing it takes effect only after a restart, and invalid entries are dropped silently rather than logged.
- **`/broadcast` video parsing does not match its own help text.** The usage message advertises `--video=filename.mp4`, but the handler matches `/123video=(\S+)/i`. The resolved path is `<cwd>/videos/<filename>`; that directory is not part of the repository and is git-ignored, so you must create it yourself if you want video broadcasts.
- **The bot's own @handle is hardcoded** in the caption attached to every delivered video (`bot.service.ts`). Forks will advertise the original bot until they change it.
- **`Movie.expiresAt` is unused.** The column exists; no code reads or writes it.
- **`Request.userId` is not a foreign key.** It stores a raw Telegram id, so it cannot be joined to `User` through Prisma.
- **`User.telegramId` is a `Float`.** Telegram ids are integers; `BigInt` would be the correct type. Changing it is a breaking migration.
- **Long polling only.** No webhook mode, so exactly one instance can run per bot token.

---

## Contributing

Contributions are welcome — issues and pull requests both.

1. Fork the repository and create a branch from `main`: `git checkout -b feat/your-change`.
2. Install dependencies and set up your `.env` as described in [Setup and installation](#setup-and-installation). Use a **separate test bot and database** — never point a development instance at a live bot token.
3. Make your change. Run `npm run lint` and `npm run format` before committing; ESLint and Prettier are wired together, so a lint failure is often just a formatting one.
4. If you touch `prisma/schema.prisma`, generate a migration with `npx prisma migrate dev --name descriptive_name` and commit the generated folder in `prisma/migrations/`. Never hand-edit an existing migration that has already been committed.
5. Run `npm test` and `npm run build`.
6. Commit messages follow the existing loose Conventional Commits style: `feat:`, `fix:`, `chore:`.
7. Open a pull request describing what changed and how you verified it.

Please **never commit a `.env` file, a bot token, a database password, a Telegram user id or a real channel id.** Document any new environment variable in `.env.example` with a placeholder value.

---

## License

Released under the [MIT License](LICENSE). See the `LICENSE` file for the full text.
