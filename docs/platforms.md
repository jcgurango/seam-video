# Platforms: desktop first, web and cloud on hold

**Decided by JC, 2026-11-23:** Seam focuses on the desktop experience (the
Electron editor, the preview app and the CLI). The web shell (`@seam/web`)
and Seam Cloud (`@seam/cloud`) are left to stagnate: no new features and no
parity work. Nothing is being deleted.

For now both still build and their tests still run in `pnpm build` /
`pnpm test`, because `@seam/web` mounts the same `@seam/editor` `App` as
the desktop shell.

## Why web existed

Two design decisions, both of which have since gone away:

1. **iPhone HDR rendering.** Electron's Chromium rendered iPhone HDR
   footage (HLG / Dolby Vision) inconsistently, while desktop Chrome always
   got it right, so the web editor was the dependable way to see footage
   correctly. Since the Electron upgrade (Electron 45 / Chromium 156) JC's
   tests show it rendering consistently, so the crutch is no longer needed.
2. **Mobile.** The web editor was the path to editing on a phone. The
   mobile UX has been removed pending a future rework (see CLAUDE.md), so
   that reason is gone too.

## Why cloud existed

The starting use case was: *my footage is on my phone and already backed
up; let me edit it there instead of downloading it first.* Cloud grew from
that (media sync, transfer queue, remote `.seam`, the generator proxy).

The long-tail idea behind it was "I have no setup and I must edit". In
practice JC has yet to edit on a device that did not already have Seam set
up.

## Why the extension system tips the balance

Extensions mean installations can diverge: each one may install a different
set, and a document using a field or node type that an installation lacks
does not validate there. A hosted editor that opens "any project" stops
being a coherent promise. If web comes back, it is as a **curated set**: a
fixed list of extensions chosen for that build, not a mirror of whatever a
desktop installation runs.

## What this means day to day

- New editor work is verified in the desktop shell, not the web one.
- Pieces that started for cloud but serve the desktop stay maintained:
  `@seam/media-source` (the bounded-Range block cache and cut planner) is
  also how the renderer and CLI read `http(s)://` sources, including remote
  `.seam` renders.
- The web-only features (OPFS storage, the Cloud menu, remote `.seam`
  export / import, the web project browser) are not extended. Treat their
  sections in CLAUDE.md as describing frozen code.
