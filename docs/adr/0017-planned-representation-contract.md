# Page planning owns representation questions

Page planning now selects a closed Page Type and zero or more Diagram Specs,
while page work implements those exact questions as evidence-anchored Mermaid.
The State Gate enforces the type matrix, plan/body correspondence, basic
Mermaid structure and accessibility metadata; independent review remains
responsible for renderability and semantic correctness. This separates Flow
and Lifecycle from overloaded Domain prose without creating graph sidecars or
making diagrams the only consumer interface. The Run contract changes from
`source-plan-dag` to `source-plan-diagram-dag`; legacy Run state is rejected,
with no migration or OKF version change.
