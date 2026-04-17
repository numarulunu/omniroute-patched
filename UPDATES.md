# OmniRoute — Update workflow (for Ionut's patched fork)

This repo is a **patched fork** of `diegosouzapw/OmniRoute`. The Hetzner
deployment builds from this local tree, not from upstream directly.

```
upstream (diegosouzapw/OmniRoute)
      │
      └── origin/main     ← pristine mirror (never edit)
             │
             └── main     ← tracks origin/main, kept in sync, never edit
                    │
                    └── ionut-patches   ← our edits live here
```

## Mental model

Think of `main` as a book someone else is writing, and `ionut-patches`
as sticky notes we've added on specific pages. When a new edition ships,
git peels the notes off the old edition, loads the new one, and puts
each note back. Notes whose page was rewritten get handed back to you
to re-place by hand — that's a "conflict."

## The patches currently on `ionut-patches`

- `src/app/api/providers/codex/import-auth-json/route.ts` — NEW
- `src/app/api/providers/claude/import-credentials-json/route.ts` — NEW
- `src/app/(dashboard)/dashboard/providers/[id]/page.tsx` — MODIFIED
  (adds Import buttons + hidden file inputs for Codex and Claude)
- `src/sse/services/auth.ts` + `tests/unit/sse-auth.test.mjs` — MODIFIED
  (SSE auth hardening)
- `patch-*.js` — source-level idempotent patch scripts (reusable;
  run after a fresh upstream clone, before `docker build`)

Non-patch noise that's intentionally NOT committed:

- `package-lock.json` mutations — always deleted before `docker build`
  (see deploy procedure in memory)
- `.serena/` — ignored (dev tool)
- `bin/*` CRLF-only diffs — ignored

## Update workflow

Run on the PC (Git Bash) when you want to pull in new upstream work.

### Step 1 — grab what upstream shipped

```
git checkout main
git pull origin main
```

`main` now mirrors upstream. If nothing changed, you're already done.

### Step 2 — replay your patches onto the new upstream

```
git checkout ionut-patches
git rebase main
```

Three possible outcomes per patched file:

1. **Upstream didn't touch it** → patch reapplies silently. Zero work.
2. **Upstream touched it far from your edit** → git auto-merges. Zero work.
3. **Upstream rewrote the area you patched** → rebase pauses, shows you
   both sides with `<<<<<<<` / `>>>>>>>` markers. Pick / merge / save.
   Then:
   ```
   git add <the-file>
   git rebase --continue
   ```

Worst-case abort: `git rebase --abort` returns you to where you started,
no harm done.

### Step 3 — build-test the merged result

Git can merge text cleanly while the _meaning_ underneath drifts — e.g.
upstream renamed a function your patch calls. Catch that locally:

```
npm install
npm run build
```

If build passes, the merge is real. If it fails, fix the import / type /
signature the error points at, commit, and move on.

### Step 4 — deploy

Standard procedure (see `project_omniroute.md` memory):

```bash
cd "/c/Users/Gaming PC/Desktop/Claude/OmniRoute"
tar --exclude=node_modules --exclude=.next --exclude=.git --exclude=logs \
    --exclude=.serena --exclude=.agents --exclude=.claude --exclude='*.log' --exclude=data \
    -czf - . | ssh root@178.104.203.128 \
    "rm -rf /opt/omniroute-src && mkdir -p /opt/omniroute-src && tar -xzf - -C /opt/omniroute-src && rm -f /opt/omniroute-src/package-lock.json"
ssh root@178.104.203.128 "cd /opt/omniroute-src && docker build -q -t omniroute:patched-v3 ."
ssh root@178.104.203.128 "sed -i 's|^OMNIROUTE_IMAGE=.*|OMNIROUTE_IMAGE=omniroute:patched-v3|' /opt/omniroute/.env && cd /opt/omniroute && docker compose up -d"
```

Bump the image tag each time (`patched-v2` → `v3` → `v4`...) so Docker
actually recreates the container.

## Outstanding update at time of writing

As of 2026-04-17, `origin/main` is 24 commits ahead of where
`ionut-patches` was originally based (last local pull was `v3.6.7 – 25`,
current upstream is `v3.6.7`). Running `git rebase main` will replay the
Ionut patches onto that newer tree. Budget 10–30 min for the first pass
in case the providers `[id]/page.tsx` layout drifted.

## Rules of thumb

- **Never commit on `main`.** It's a pristine upstream mirror.
- **Always rebase, never merge.** Keeps history linear; makes patches
  reproducible.
- **Patches are cheap, merges are not.** If a feature is small, prefer
  a patch commit over a long-lived branch of its own.
- **Don't chase every release.** Only pull upstream when they ship
  something you actually want. The tool is already doing its job.
- **Always `npm run build` after a rebase.** Textual merge ≠ runtime
  success.

## If git gets hopelessly tangled

`git reflog` shows every state the repo has been in for the last 90
days. Find the commit you wanted to be at, then `git reset --hard <sha>`
that branch back to it. Nothing is ever truly lost for 90 days.
