# dsh-cc-switch-skills

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that **loads every skill in `C:\Users\<current user>\.cc-switch\skills` when DSH starts**, and watches that directory for adds, renames, and deletes (no restart needed).

`~/.cc-switch/skills` is where cc-switch keeps its skills, each a directory bundle with a `SKILL.md`. This plugin feeds those skills into DSH's `ctx.skills` registry so they appear in the session skill catalog and can be loaded through the `skill` tool.

## Features

- **Loaded at startup**: the plugin row mounts with DSH, scans the directory once, and registers every skill.
- **Two skill shapes**: directory bundles `<name>/SKILL.md` and flat `<name>.md` files (one level only).
- **YAML frontmatter parsing** (aligned with the official `@deepseek-ai/dsh-skill-filesystem`):
  - `name` (kebab-case), `description` (required);
  - optional `whenToUse`, `metadata`, `disable-model-invocation`, `user-invocable`;
  - `disable-model-invocation: true` hides the skill from the model catalog; `user-invocable: false` hides it from user-facing commands.
- **Lazy body loading**: the catalog carries metadata only; every `skill` call re-reads the current file, so edits to `SKILL.md` take effect immediately.
- **Resource base**: `resourceBase` points at the skill directory so the model can resolve `scripts/`, `references/`, `assets/` and friends.
- **Live refresh**: the root is watched recursively; adds / renames / deletes / frontmatter edits land on the next catalog refresh. A missing root is probed until it appears.
- **Rank 300**, same tier as the official `custom` skill root: project skills win name clashes, user-level skills lose.

## Install

Clone the repository and install its dependency first:

```powershell
git clone https://github.com/artorias-zj/dsh-cc-switch-skills.git
cd dsh-cc-switch-skills
pnpm install   # or npm install — only pulls in the yaml dependency
```

Then wire it into DSH (below, `<path>` is the clone directory's absolute path):

1. **From DSH (recommended)**: run `plugin_manager` `install_bundle` targeting `<path>`, or install the local path from the Web sidebar Plugins page.
2. **Manually**: add `"dsh-cc-switch-skills": "link:<path>"` to `dependencies` and `"dsh-cc-switch-skills"` to `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json`, then run `pnpm install` in the profile directory.

> Note: DSH references the local directory via `link:` — keep the clone (including `node_modules`) in place.

Once installed (live profiles apply immediately; otherwise restart DSH) the skills show up in the session catalog.

## Configuration

Optional `config` fields on the inserted row in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `dir` | `<homedir>\.cc-switch\skills` | Root to scan; `~/` prefix supported; also overridable via `DSH_CC_SWITCH_SKILLS_DIR` |
| `providerName` | `cc-switch` | Provider name registered into `ctx.skills` (must not be the reserved `runtime`) |
| `rank` | `300` | Precedence against other providers on name clashes; lower wins |
| `watch` | `true` | Watch the directory and refresh automatically |

## Differences from the official provider

To achieve "load *every* skill", incomplete frontmatter is tolerated more than the official provider:

- missing (or non-kebab-case) `name` → falls back to the directory / file name with a warning;
- missing `description` → falls back to the first non-empty body line (truncated to 160 chars) with a warning.

Still skipped with a warning: invalid YAML frontmatter, missing frontmatter, invalid invocation booleans (e.g. `user-invocable: maybe`), and names that stay invalid after the fallback. Warnings go to the DSH log (`hub.log`).

## Uninstall

Remove it from the DSH plugins page, or run `plugin_manager` `remove_bundle` targeting `dsh-cc-switch-skills`.

## License

MIT
