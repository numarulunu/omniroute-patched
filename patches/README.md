# Patches — standalone scripts

These scripts re-apply Ionut's OmniRoute/Codex patches in environments
where git isn't the patch mechanism (e.g. an npm-installed OmniRoute
bundle on Windows, or a fresh upstream clone you don't want to fork).

**The primary patch record is the git history on the `ionut-patches`
branch.** These scripts are a _backup_ — the same changes, expressed as
idempotent Node.js scripts that can reconstruct the patches from
scratch if git is ever unavailable.

## Layout

```
patches/
├── bundle/   Patch an installed OmniRoute ( %APPDATA%\npm\node_modules\omniroute\ )
├── source/   Patch a fresh OmniRoute source tree (before `docker build`)
└── client/   Patch the local Codex CLI config ( ~/.codex/config.toml )
```

Pick the folder that matches what you're patching. They are NOT meant
to be run on the same target.

## `bundle/` — for Windows npm-installed OmniRoute

Runs against `%APPDATA%\npm\node_modules\omniroute\app\.next\server\chunks\`.
Patches the **compiled** JS bundle that Next.js emitted at install time.

| Script                     | Purpose                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `patch-omniroute.js`       | General OmniRoute bundle patches (OAuth flow, UI tweaks). Run after every `npm install -g omniroute`.                  |
| `patch-quota-threshold.js` | Raises the Codex quota threshold to 100% so accounts only get filtered when fully exhausted (upstream default is 90%). |

**Fragility warning:** bundle patches use regex/sentinel matching on
minified/chunked output. They break when upstream rebundles. If you're
deploying to Hetzner, you don't run these — you use `source/` + docker
build instead.

## `source/` — for a fresh upstream clone

Runs at the repo root of a pristine `git clone` of upstream OmniRoute,
BEFORE `docker build`. Adds files and sentinel-guarded edits at the
TypeScript source level — more resilient than bundle patches.

| Script                                    | Purpose                                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patch-codex-import-auth-json.js`         | Adds `/api/providers/codex/import-auth-json` route + Import button in the providers page. Required for remote Codex re-auth without an SSH tunnel.                                                                     |
| `patch-claude-import-credentials-json.js` | Adds `/api/providers/claude/import-credentials-json` route + Import button. Required because Anthropic's OAuth is IP-rate-limited on headless servers. Run AFTER the Codex patch (it anchors on the Codex insertions). |

**This is what you run if someone else wants your patches but doesn't
want the whole git fork.** For normal deploys from this repo, you don't
run them — git already applied the same changes to the tree.

## `client/` — for the user's Codex CLI

Patches `~/.codex/config.toml` so the `codex` CLI routes through
OmniRoute instead of talking to OpenAI directly.

| Script                 | Status                     | Purpose                                                                                                                                                                                                   |
| ---------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patch-happy-codex.js` | **STALE as of 2026-04-17** | Points Codex at `http://localhost:20128/v1` with an old API key. Current live config points at `https://omniroute.ionutrosu.xyz/v1` with a rotated key. Don't run without updating the URL and key first. |

If you ever rebuild the user's Codex config from scratch and want to
resurrect this script, edit the hardcoded `BASE_URL` and `API_KEY` at
the top to match the current OmniRoute deploy first.

## Gaps / inconsistency

The `src/sse/services/auth.ts` hardening and its test file don't have a
patch script. They only exist as git commits on `ionut-patches`. If you
need to re-apply them to a non-git copy, `git show <hash>` gives you a
diff you can apply manually with `git apply`.
