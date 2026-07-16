# Use file receipts with control returns for agent handoff

Research Agents communicate through two separate channels: a short control return carries task identity, status, summary, and the path to the result; the run-local Analysis Workspace stores the complete bounded Analysis Receipt and optional artifacts. Receipts use Host-assigned unique paths and a temporary-file-then-atomic-rename handoff, while directory scans, lockfiles, and file existence are never treated as the control protocol.

The canonical receipt is UTF-8 JSON validated against a versioned schema. Each evidence item carries the frozen repository revision, path/line span, and content hash; a receipt is capped at 128 KiB, while long prose belongs in an optional Markdown artifact with separate Host quotas. Append-only JSONL is reserved for Host-owned run events and is not a completion signal.

Research Agents do not publish files by writing arbitrary Analysis Workspace paths. They submit the typed receipt through a Host-owned `publish_receipt` tool; the Host assigns the immutable path, validates schema and quotas, writes a temporary file, and atomically replaces the final path. Agents receive read access only to the receipts needed by their scope.

`partial` and `failed` receipts never satisfy a planned critical scope. Root may make a bounded retry or perform a direct fallback investigation; if a load-bearing scope remains incomplete, the Wiki Run does not return `Complete` and the previous Published Wiki remains unchanged. Non-critical work must be explicitly cancelled in the plan, and `NeedsInput` is reserved for genuinely missing external information rather than internal budget or child failures.

This keeps large evidence out of parent context while preserving a small, inspectable completion signal. The default workspace is deleted with the Wiki Run; an explicit diagnostic-retention option may copy a selected run before cleanup, but durable cross-run recovery is a separate decision.
