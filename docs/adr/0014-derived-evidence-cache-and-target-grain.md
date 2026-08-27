# Derived Evidence Cache; one Target owns one canonical artifact

Survey workers write only Survey JSON. After locator validation, the kernel
derives a versioned, Pin-bound Evidence Cache with numbered source windows;
connect, plan and write may read it, dispatch rebuilds it, and review ignores
it and reopens Pins. The cache is never part of Target identity.

Survey and write Targets each own exactly one canonical artifact. We rejected
persisted batch Targets because their synthetic manifests broke completion,
reuse and review invariants. A worker session may process a short sequence of
affine Targets, but that execution optimization creates no state or artifact.
This amends ADR 0009's write-spawn rule.
