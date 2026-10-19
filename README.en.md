# Session Live Preview · dsh-session-live

> See **what a session is doing right now**, right inside the DSH sidebar hover card.

DSH's built-in hover card shows four things: the title, a relative timestamp, a status dot, and
`running` / `idle`. This plugin inserts a live activity panel between the timestamp and the status
line, answering five questions:

- **Which tool is running** — its name, an argument summary, and how long it has been running
- **What just happened** — a compact strip of the most recent tool calls
- **What was said** — one-line previews of the latest prompt and reply
- **How much was spent** — turns, total tokens, and the model's short name on one line
- **What images were sent** — a thumbnail of the latest user-uploaded image in the session (**click to enlarge**)

Plus a **dedicated settings page**: per-item toggles, density, strip length. Changes apply
immediately and persist with the profile.

---

## How it differs from neighbouring plugins

| Plugin | Question it answers |
|---|---|
| `@comecaramelos/dsh-hover-information` | How much did this session **cost** (turns / tokens / cache / context window)? |
| `dsh-ballast` | How full is the context window? |
| `dsh-git-badge` | What **action** does this session need from you? |
| **dsh-session-live** (this one) | What is this session **doing right now, and where is it stuck**? Plus one summary line: turns / total tokens / short model name. |

Only that one total line: no cache breakdown, no context gauge, no cost math — those belong to
the plugins above, and installing both never shows the same numbers twice. Token values are read
straight from the host's built-in `tokenUsage` projection (`@deepseek-ai/dsh-token-meter`); the
plugin never counts them itself, never folds them itself, and issues no extra requests.

---

## Install

### Option 1 — the official command

```powershell
dsh plugin --profile web add file:J:/plugin/dsh-session-live
```

### Option 2 — by hand

Edit `%DSH_HOME%\profiles\web\package.json` and do **both** steps:

1. Add `"dsh-session-live": "file:J:/plugin/dsh-session-live"` to `dependencies`
2. Append `"dsh-session-live"` to `dsh.profile.bundles`

Missing step 2 is the classic "installed but never started" trap: `cordis.patch.yml` can only
patch an entry that was **already inserted**. Patching a row that nothing ever inserted starts
nothing.

Restart DSH (`dsh web`) afterwards and reload the page.

---

## Settings

`Settings → Session live preview`, twelve items:

| Item | Default | Meaning |
|---|---|---|
| Enable hover live preview | on | Master switch; when off the card gains nothing |
| Show current activity line | on | Running tool + argument summary + elapsed time |
| Show recent tool sequence | on | Compact strip of recent tool calls |
| Show content preview | on | Latest prompt and reply previews |
| Show timing | on | Turn / step / tool elapsed time |
| Show errors | on | Tool failures, aborted turns, interrupted streams |
| Show compaction marker | on | A hint when context compaction happened |
| Show image thumbnail | on | Thumbnail of the latest user-uploaded image in the session |
| Show model name | on | Short model name inside the usage line (off = that line drops the model) |
| Show usage summary | on | One line: turns · total tokens · short model name |
| Compact mode | off | Tighter spacing and smaller type |
| Recent tool strip length | 5 | 0–12; 0 hides the strip |

Settings are written into the profile's plugin entry (`ctx.settings`, the same source `dsh config`
reads), so they stay consistent across browsers and machines. If the host's SettingsForms is
unavailable the plugin falls back to its own route, then to `localStorage`; the settings page
footer always shows which channel is in use.

Where the page lives: **account menu → Settings → the "Session preview" entry at the bottom of the
left rail**. That entry appears because the `settings.section` registration carries a `label`; without
one it renders as a blank, unclickable row. First-party sections (`dsh-client-ui-settings-models` and
friends) use `label: () => t('nav')`, and this plugin matches that. The field is registration-time
metadata, so changing it **requires a dsh web restart**.

---

## Architecture

```
┌─────────────────── Host (Node) ────────────────────┐
│  index.js / src/index.js                           │
│   ├─ src/activity.js   fold: event stream → state   │
│   ├─ register the liveActivity projection (wire)    │
│   └─ mount /session-live/api/{health,overview,detail,settings,image}
└────────────────────────────────────────────────────┘
                     │ projection values ride the session-list snapshot
┌─────────────────── Browser ────────────────────────┐
│  client.js (hand-written CJS, zero build)           │
│   ├─ sidebar.session.row.hover → live activity panel│
│   ├─ settings.section          → dedicated page     │
│   └─ reads byId[sessionId].projectionValues.*       │
└────────────────────────────────────────────────────┘
```

### Why "host projection + list snapshot" instead of `useProjection`

The `sidebar.session.row.hover` seat's owner supplies **only a `sessionId`** (the official source
explains why: a Session-scoped seat would force-activate and retain every listed session).
`useProjection(key)` is bound to the *current* session and cannot read an arbitrary one.

So the data must be computed on the host and pushed per session id along with the list snapshot —
which also satisfies the "hovering triggers no I/O" rule: opening a card reads whole values already
in memory, with zero round-trips.

### Fold discipline

- `apply` is synchronous, pure, and returns plain JSON.
- Events unrelated to this unit return **the same state reference**, letting the host suppress
  publication via `Object.is`.
- `wire.view` caches its result the same way.
- No `Date.now()` inside the state: elapsed times are computed client-side from boundary stamps.

### Image thumbnail & model name (v2)

- The folder listens to `user/message` (scanning `data.content` for `{type:'image', attachment}`,
  keeping the last one) and `model/selection` (`data.provider/model/reasoningEffort`). Two new state
  fields `image` / `model`, **`stateVersion` bumped 1→2**. Checkpoint rows with the old version are
  replayed from seq 0 by the host — zero data loss; a cold session heals on its next event.
- Thumbnails are served by `/session-live/api/image?ref=sha256:<64hex>&type=<mediaType>`, reading
  `$DSH_HOME/attachments/v1/objects/<2-char prefix>/<sha>` directly. The `ref` must match a strict
  allow-list regex (no user-controllable path component, traversal impossible); `type` goes through
  a MIME allow-list, falling back to `image/png`; content addressing means the bytes never change,
  hence the `immutable` cache header. This route does **not** depend on any host attachment service.
- Two new settings ("Show image thumbnail", "Show model name"; 11 fields total). `src/shared.js`'s
  SETTINGS_SPEC is the single source of truth — host Config and client strings all derive from it.

### Click-to-enlarge (v3)

- Clicking the thumbnail opens the full image. The overlay is **plain DOM, deliberately not part of
  the React tree** (`src/client/viewer.js`): the host unmounts the whole plugin subtree the moment
  the pointer leaves the session row, so an overlay living in that tree would vanish before you
  could look at it. The overlay is appended straight to `body` and owns its own lifetime — Esc or a
  click on the backdrop closes it, and closing removes the `keydown` listener (skipping that is a
  leak; a dedicated check watches for it).
- Clicking the image itself does **not** close it. Only one overlay may exist at a time; opening a
  new one removes the previous one first.
- The click handler calls **both** `preventDefault` and `stopPropagation` — the session row has its
  own click handler, and letting the event bubble would open the session as a side effect.
- `z-index:1300`, above the highest value found anywhere in the host's client bundles (measured
  maximum: 1250).
- The backdrop colour uses the host theme variable `--dsw-alias-bg-mask-drop`. This is the plugin's
  **only** theme-aware colour: the backdrop sits over the whole page, so it must follow light/dark.
  The hover panel does the opposite and pins its colours, because the host hover card hardcodes a
  dark background. The two rules are inverted — do not copy one into the other.
- In `client.js`, `CSS_TEXT` is a **string** (`[...].join('\n')`), not an array.

### Lighter panel & one summary line (v4)

The panel shrinks by **merging**, not by stacking: the standalone model row and the "recent ›"
title row are gone, replaced by one trailing summary line; the default thumbnail height dropped
from 96px to 72px (56px in compact mode). The worst case went from 7 rows to 4.

- **One summary line** (`UsageLine`): `turns · total tokens · short model name`, e.g.
  `131 turns · 6.9M · deepseek-v4.1-flash`. Hover it for the breakdown (input / output / reasoning effort).
- **Tokens are never counted here**: the line reads `row.projectionValues.tokenUsage` (the host's
  built-in `@deepseek-ai/dsh-token-meter` projection, key `tokenUsage`, `stateVersion` 2).
  input = `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`, output = `outputTokens`.
  **No new route, no new fold, no extra request.**
  - Why it is available: `dsh-api-session-controller/lib/types/list.js:282` calls `projectionsFor`
    **without a `keys` argument**, and `dsh-session-projection/lib/index.js:243-261 viewCheckpoint`
    returns **every registered projection that has a `wire`** when keys are omitted — the host has
    already computed `tokenUsage` into that same snapshot.
  - Missing means hidden: a hot session's first frame may not have the cell yet;
    `tokenUsageOf` returns `null`, the line just omits one part. **A missing total never blanks the
    whole panel** (`hasContent` treats tokens as a bonus, not a requirement). All-zero counts as
    "no usage yet" rather than printing `0`.
- **Turns come from the plugin's own fold** (`liveActivity.turn`, counted on `turn/start`). It was
  cross-checked item by item against the host's authoritative `sessionStats.turns` (24/24 match);
  the only divergence is that the host counts turns with a *closed step*, so a one-turn difference
  is expected.
- **Plain-language Q&A** (`plainText` / `isInjectedText`):
  - Paired injection blocks are dropped whole: `<system-reminder>` / `<untrusted-memory>` /
    `<available_skills>` / `<project_instructions>` / `<skill_content>` and friends.
  - Host-wrapped English metadata lines are dropped line by line: `Image "…"`, `Normalized copy`,
    `Source dimensions`, `[folded images:…]`, `[Compressed conversation section]`.
  - Then loose tags, code fences, table rows, markdown marks and list bullets go, and whitespace is
    collapsed — so the prompt field shows the sentence the human actually typed.
  - **Machine-injected messages never overwrite the last real prompt**: `user/message` first runs
    `isInjectedText`; when the whole message is injected it is skipped, keeping the prompt that came
    from him. Four families are covered (each one caught in real sessions on 2026-10-19):
    - runtime context: `current runtime context.`, `this snapshot supersedes earlier runtime-context
      snapshots.`, `time sampled while preparing turn`, `current working directory:`
    - compression placeholder: `[compressed conversation section]` (its marker line is removed by
      the metadata filter first, so this check has to happen *before* unwrapping)
    - model switch: `[model changed:`
    - scheduler: `[schedule reminder` (either case)
    - background job receipt: `background job <id> (<cmd>)`
- **`stateVersion` stays at 2**: v4 changed only *value semantics*, not the row structure (field set
  and types are unchanged), so old v2 rows still pass `stateSchema.parse` — **no version bump**.
  Bumping it would discard every older session's disk row on the read path (`viewCheckpoint` checks
  `ver` first) and blank the panel for good. Injected text inside old rows gets overwritten the next
  time a `user/message` arrives, so they heal by themselves.
- **View-level sanitising** (`cleanPreview`): keeping `stateVersion` at 2 means the host **never
  replays** old rows, so injected text written into checkpoints back in v2 would stay there
  forever. `buildView` therefore re-cleans `prompt` / `reply` on the **read path**
  (`isInjectedText` → empty, otherwise `plainText` + truncate) without touching the state — stale
  values go clean immediately and the `Object.is` publication suppression is unaffected. The clean
  is idempotent, so values produced by the new folder pass through unchanged.
- **Both new helpers are pure**: `formatTokens` (0 / 999 / 1K / 15K / 1.2M) and `shortModel` (takes
  the segment after the last `/`, strips a `-YYYYMMDD` or `-YYYY-MM-DD` suffix, truncates past 20
  characters) — no DOM involved, asserted directly by `test/load-check.mjs` and
  `test/probe-usage-snapshot.mjs`.

---

## Development

```powershell
cd J:\plugin\dsh-session-live
# full run — 29 suites (recommended)
Get-ChildItem test -Filter *.mjs | Where-Object { $_.Name -notmatch 'probe-ctx' } | ForEach-Object { node $_.FullName }

# or the main ones
node test/load-check.mjs          # 27 client-bundle checks
node test/activity-check.mjs      # 42 host fold + route + view-sanitize checks
node test/probe-image-route.mjs   # image route, byte-level comparison + traversal interception
node test/probe-usage-snapshot.mjs # tokens and turns readable on the real path — 15 checks
node test/probe-zoom.mjs          # click-to-enlarge: 20 behaviour checks on a fake DOM
node test/accept-live-render.mjs  # real host values → real bundle → render (needs DSH running)
```

Most suites need no DSH running: the client is loaded in `node:vm` with a mock `__ModuleLoader__`
and `require('react')`; the host runs against a mock `ctx`. Only `accept-live-render.mjs` needs a
live instance (SKIP instead of FAIL when unreachable).

### Making a local change take effect

- **Host half** (`index.js` / `src/*.js`): `dsh-client-hmr` rebuilds on file change, but
  **projection registration and routes are host-side — restart `dsh web` to be safe**.
- **Client half** (`client.js`): HMR recomputes the artifact revision and publishes it to the
  browser, so **no restart is usually needed**.
- The authoritative ways to confirm code actually took effect: ① byte-compare the combo endpoint
  (`test/probe-bundle.mjs`); ② response-body shape. **Never infer from PID / boot time.**

---

## Compatibility

- DSH `>=0.2.0-rc.1 <0.3.0-0` (developed and verified on `0.2.1-rc.2`).
- Only stable services are used: `slots`, `locale`, `webServer`, `settings`, `sessionProjections`,
  `sessions`. Any missing capability degrades silently instead of parking the plugin in pending.
- The client `require`s only `react` from the host's seed table and value-imports no
  `@deepseek-ai/*` package.

---

## Known limits

- Unflushed streaming increments (`assistant/assistant-stream` frames) are not wired yet; the panel
  reflects the last durable state. Wiring them is the next step.
- The hover card itself has an 800ms open delay (host behaviour); panel data is ready the moment the
  card appears.
- The panel mounts only while a card is open, so idle sessions cost nothing.

---

## License

MIT
