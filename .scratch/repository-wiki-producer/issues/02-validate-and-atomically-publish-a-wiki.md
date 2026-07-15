# 02 — Validate and atomically publish a Wiki

**What to build:** A repository owner can publish a complete, mechanically valid Wiki from staging, while invalid output, failed retries, and filesystem errors leave the previous Published Wiki unchanged.

**Blocked by:** 01 — Establish the Wiki Run harness.

**Status:** ready-for-agent

- [ ] Define one stable Source Citation contract containing a repository-relative POSIX path and one-based inclusive line range.
- [ ] Derive the actual staged file manifest independently and reject missing, undeclared, duplicate, escaped, unsupported, or temporary output.
- [ ] Validate required entry content, declared frontmatter, relative internal links and fragments, Source Citation syntax, cited path existence, and cited line ranges.
- [ ] Feed recoverable terminal validation defects back through the bounded PydanticAI output-retry mechanism.
- [ ] Generate publication metadata containing source revision, Producer Skill digest, model identity, generation time, page hashes, and complete Wiki content digest.
- [ ] Publish only after a Complete result and successful validation.
- [ ] Replace the Published Wiki atomically so readers observe either the old complete tree or the new complete tree.
- [ ] A Needs Input result, invalid output, exhausted retry budget, interruption, or publication failure does not change the Published Wiki or record successful publication metadata.
- [ ] Failure-injection tests cover validation, metadata creation, and replacement boundaries through the full Wiki Run seam.
- [ ] Existing Markdown and YAML dependencies plus standard-library filesystem and hashing facilities are reused instead of introducing a Renderer or validation framework.
