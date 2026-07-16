# 09 — Configure multi-repository Wiki Runs

**What to build:** A repository owner can keep provider secrets in the process environment and use one non-secret YAML file to generate or refresh a Wiki from multiple named local repositories, branches, exact revisions, and explicit ignore patterns.

**Blocked by:** 08 — Finalize the greenfield package and documentation.

**Status:** ready-for-agent

- [ ] Ship an ignored `.env` convention and tracked `.env.example` for OpenAI and other supported PydanticAI provider variables without adding a dotenv loader.
- [ ] Reject credentials, tokens, passwords, and provider headers from Wiki Run YAML without echoing their values.
- [ ] `wiki-run --config` accepts relative output paths, model selection, limits, an optional Skill Version, and one or more uniquely named repositories.
- [ ] Each repository selects exactly one local branch or exact revision; branches freeze to complete commits before model work.
- [ ] Explicit standard-library `fnmatch` patterns remove repository-relative tracked POSIX paths before source quotas and materialization.
- [ ] Multiple Repository Snapshots remain read-only below `/source/<repository-id>` while only the Staging Wiki is writable.
- [ ] Multi-repository Source Citations include the repository ID and fail validation when the ID is missing or unknown.
- [ ] Publication metadata records every repository ID, exact revision, and ignore set.
- [ ] Direct single-repository CLI usage remains available as the shortest path.
- [ ] A fresh-wheel test completes a multi-repository YAML Wiki Run through the installed public CLI.
