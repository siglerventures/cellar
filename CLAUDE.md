# Cellar — conventions for Claude Code (read before editing)

A Philinity ecosystem app: a single `index.html` (HTML + inline JS, Firebase
Realtime Database backend, Google sign-in), hosted on GitHub Pages
(`siglerventures.github.io/cellar`). Wine cellar inventory + tasting log.

## Single-file / no build
- Everything lives in `index.html`. No framework, no build step. Firebase
  modular v10 SDK imported from the versioned CDN (matches Eats Rev 10.17).
- All functions used by inline `onclick` handlers MUST be exposed via `window.*`.

## Versioning — bump every change
- The rev is shown in TWO places: the `<title>` and the visible footer/version
  badge (and the login screen badge). Bump all of them together on every change.
- Never reuse a rev number. Working filename may carry the rev
  (e.g. `cellar_Rev1.1.html`); committed to GitHub as `index.html`.

## Data model (RTDB, project `philinity-893d2`)
- Root node: `/cellar` — `people/{emailKey}`, `bottles/{bottleId}`,
  `buylist/{itemId}`, `racks/{rackId}`, `history/{eventId}`, `ask_history`.
  Legacy `rack_layout` is a read-only fallback — never write to it.
- One `bottles` collection holds cellar (unopened) and rated items,
  distinguished by `status` (`cellared` | `opened`). Other key fields:
  `kind` (missing = `wine`; else `bourbon|tequila|vodka|cigar|mixer`),
  `price`, `vendor`, `grape` (free text; varietal % breakdowns are parsed
  client-side), `tags`/`tag`, `photos:[{path,url}]` + `photoUrl/photoPath`
  (main), `rackId`+`rackCol`+`rackRow` (missing rackId = `main`),
  `archived` flag (archive, don't delete — restore via 📦 Data).
- `racks/{id}`: `{name, cols, rows, cells:{c_r:{label}}, order}` — the rack
  map renders entirely from this; `main` is the migrated Wine Wall.
- `history`: append-only activity events (`logged/added/opened/placed/
  swapped/unplaced/archived/restored/merged`, with `restock` flag) — History
  tab money stats derive from bottles (incl. archived), not events.
- Adding an already-cellared wine (same name+vintage, accent-insensitive)
  RESTOCKS qty instead of duplicating; duplicates can be merged via the
  detail modal. Storage photos live under `cellar/bottles/{id}/` (the
  Storage rules allow `/cellar/**` — NOT `wine_cellar`).
- `emailKey`: lowercase, dots → underscores via chained `.split('.').join('_')`
  (RTDB rules `.replace` is first-occurrence-only — sanitize fully in app code).

## Bot coordination (two CodeBots ship daily — avoid collisions)
- Rev numbers: check main AND open PRs before claiming one; if in doubt, skip
  a number. We have collided on 2.16/2.19/2.37/2.38/2.44.
- Functions: Node 22 runtime (`npm install` after pulling before any deploy);
  always deploy with `--only functions:cellar:<name>` filters.
- NEVER republish global RTDB/Storage rules wholesale — change only the
  cellar block, additively. A global rules rewrite once orphaned Cellar's
  roster and blanked the app for members.

## Access / roles
- Roster at `/cellar/people/{emailKey}`, roles `admin` | `member`. The People
  modal (admin-only, footer) is the only onboarding step. Do NOT hardcode UIDs
  for non-root users.
- Two ROOT admin UIDs are hardcoded admin (lockout-proof), same as Eats.

## Firebase rules (shared project — highest risk)
- `philinity-893d2` shares ONE database + ONE rules file across apps (Eats,
  others). The Cellar `/cellar` block must be ADDITIVE — never drop, overwrite,
  or wildcard another app's block. Verify Eats' block is intact after publishing.
- Rev 1.0 uses `auth != null` on `/cellar`; people-management writes gated to the
  two root UIDs + `admin` role. See `firebase-rules-cellar-block.json`.
- Cloud Functions share ONE namespace across apps too. `askAI` (unprefixed)
  belongs to EATS — Cellar must NEVER export, deploy, delete, or modify it, or
  anything else Eats-related. Prefix all Cellar functions (`cellarAskAI`, …),
  check `firebase functions:list` before choosing a name, and always deploy
  with explicit `--only functions:cellar:<name>` filters (never a bare
  `--only functions`, which could prompt deletions of other apps' functions).

## Pull-request hygiene
- One change = one fresh branch = one new PR; share the link on push.
- Do NOT push new commits expecting them to attach to an already-merged PR — open
  a NEW PR. Flag any force-push of a shared branch.

## Roadmap (from the handoff spec)
- Rev 1.0 — auth + roster + RTDB + quick-log + four views + palate + seed (this).
- Rev 1.1 — camera capture + client compression + Storage upload + thumbnails.
- Rev 1.2 — `scanLabel` Cloud Function (key server-side) + snap-the-label autofill.
- Rev 1.3 — optional `predictScore` function; buy-list management UI.
