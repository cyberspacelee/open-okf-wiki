# Repository Wiki Producer

`@okf-wiki/wiki-workflows` is a Pi extension that generates a source-grounded
repository Wiki from one or more Git repositories. The Lead session uses a
generic `subagent` tool; stages live in `prompts/lead.md` and `agents/*.md`.

```bash
pnpm build
pi install ./packages/wiki-workflows
```

The host skill `repository-wiki-producer` is the only model-facing skill
(`pi.skills`). Lead SOP is `prompts/lead.md`. Workers are `agents/*.md`.

Run Pi in the repository and use:

```text
/wiki [focus]
/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]
/wiki source add link <local-path> [--name <name>] [--workspace <dir>]
/wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]
/wiki status [run-id]
/wiki runs
/wiki pause
/wiki resume [run-id]  (does not restore Pi sessions; run /wiki again)
/wiki cancel [run-id]
```

Every `/wiki` invocation starts an isolated full generation in a fresh empty
Candidate. Optional focus prioritizes research without dropping essential
coverage. A Git repository
without `workspace.yaml` is used directly as an implicit single source.

For multiple repositories, run `init` to create an explicit workspace. It
defaults to the current directory, `--lang zh`, standard source ignores, and no
extra excludes. `--exclude` is repeatable. `source add link` accepts only a
local Git repository root and creates a symlink on Linux/macOS or a directory
junction on Windows. `source add clone` clones a local or remote Git URL and can
checkout `--ref`; use it when filesystem links are undesirable or unavailable.
`--name` overrides the derived workspace directory name.

`wiki.exclude` in `workspace.yaml` is the only Wiki runtime field. Change the
pipeline by editing `prompts/lead.md` and `agents/*.md`.

## Wiki topology

Pages sit beside their concept. Host generates every `index.md`.

```text
wiki/
  index.md                 # host
  overview.md
  architecture.md          # optional
  <source>/
    index.md
    source.md
    <domain>/
      index.md
      domain.md
      <concept>/
        concept.md
        models.md / flows.md / sequences.md / states.md / data.md / modules.md
```

`publish` validates OKF (`type` on concept pages), path grammar, and source
citations, then renames the Candidate to `wiki/`.

## Execution

`createProductionWikiProducer()` pins Sources, runs the Lead with `subagent`
and `publish`, and installs on validation. One Workspace has one non-terminal
Run. `/wiki status` prints text; the Pi TUI is the interactive surface.
