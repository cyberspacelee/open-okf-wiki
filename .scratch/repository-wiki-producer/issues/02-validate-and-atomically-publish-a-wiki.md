# 02 — Validate and atomically publish a Wiki

**What to build:** A repository owner can publish a complete, mechanically valid Wiki from staging, while invalid output, failed retries, and filesystem errors leave the previous Published Wiki unchanged.

**Blocked by:** 01 — Establish the Wiki Run harness.

**Status:** ready-for-agent

- [x] Define one stable Source Citation contract containing a repository-relative POSIX path and one-based inclusive line range.
- [x] Derive the actual staged file manifest independently and reject missing, undeclared, duplicate, escaped, unsupported, or temporary output.
- [x] Validate required entry content, declared frontmatter, relative internal links and fragments, Source Citation syntax, cited path existence, and cited line ranges.
- [x] Feed recoverable terminal validation defects back through the bounded PydanticAI output-retry mechanism.
- [x] Generate publication metadata containing source revision, Producer Skill digest, model identity, generation time, page hashes, and complete Wiki content digest.
- [x] Publish only after a Complete result and successful validation.
- [x] Replace the Published Wiki atomically so readers observe either the old complete tree or the new complete tree.
- [x] A Needs Input result, invalid output, exhausted retry budget, interruption, or publication failure does not change the Published Wiki or record successful publication metadata.
- [x] Failure-injection tests cover validation, metadata creation, and replacement boundaries through the full Wiki Run seam.
- [x] Existing Markdown and YAML dependencies plus standard-library filesystem and hashing facilities are reused instead of introducing a Renderer or validation framework.
