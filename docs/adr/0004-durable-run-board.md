# Durable Run Board outside the conversation

The Lead's goals and remaining work live in the host-owned current Run Board at
`.okf-wiki/run/board.json`, not in Pi session entries or the compacted
transcript. After compaction or
`/wiki resume`, the host re-injects that Board. Pi's example todo tool stores
state in tool-result details so branches stay consistent; that is the wrong
owner here because compaction drops those details from the model context, and
Wiki Runs also continue after process restart. Amp later removed in-thread
todos because a single short thread can track itself — a compacted, pausable
Wiki Run cannot.
