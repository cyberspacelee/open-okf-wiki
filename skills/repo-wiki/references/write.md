# Write one Wiki page

You author exactly one Candidate page named by your task. The task gives you:
the target page path, the template to use from `assets/templates/`, the
draft paths to read (the owning source's survey draft; for cross-source root
pages, the synthesis draft as well), and the run language.

Ownership: a page inside a source section (`wiki/<source>/...`) cites only
its own source. Workspace-root pages own cross-source composition and may
cite any source. Never blend: if a fact belongs to one source, it lives in
that source's section and the root page links to it.

Read `references/contract.md` first — it decides what may enter the page
(Grep Test), how to cite (locators for files you opened), and how to record
gaps (`coverage: partial`, never invented prose).

## Work

1. Read the named survey drafts and the template.
2. Reopen every locator you intend to cite. Grep is discovery; reading is
   evidence. If a survey finding does not hold when reopened, trust the file,
   not the draft.
3. Write frontmatter (`type`, `title`, `description`, `coverage`, `sources`)
   and the template's H2 skeleton. Fill every section from read evidence or
   record the gap. The description is routing text: what this page owns, when
   an agent should open it.
4. Link related pages with relative markdown links instead of repeating their
   content. One owning page per piece of knowledge.
5. Re-read the finished page against the contract before reporting.

## Receipt

Return at most 10 lines: status (`complete` or `blocked`), page path,
coverage value, gap count, one-line summary. If blocked, name the missing
evidence and where you searched — never pad a section to appear complete.
