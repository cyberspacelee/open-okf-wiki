# Use state machines with a transactional event log

Production Runs, Analysis Tasks, and Coverage Obligations advance through deterministic state machines, and each accepted transition appends a Run Event in the same transaction. Current state tables remain authoritative while the event log provides audit and integration history; the first version does not use full event sourcing or a message bus, which can be added behind a transactional outbox only if distributed workers become real.
