# Source Brief fan-in for multi-code-Source planning

When a Run has more than one Git/files Source, it starts one `plan:<source>`
Target per Source. These Targets run independently and write bounded Source
Briefs containing roles, lifecycle or invariant candidates, local evidence,
cross-Source counterpart queries and gaps. `plan:workspace` depends on every
Brief, verifies cross-Source boundaries and remains the only Page Plan writer.
Single-code-Source Runs keep one direct `plan:workspace`; Catalog Sources are
handled there. Plan review reads the Plan and all Briefs and can route a
Source-specific recall defect back to its scout.

The kernel persists Brief attempts, validates their Source ownership, paths,
counterparts and Locators, and gives each scout its own navigation budget.
Refreshing a Source reopens only its scout, Workspace synthesis, Plan review
and Page DAG branches whose scopes changed. This keeps the external Target
interface at `plan`, `page` and `review` while making multi-repository analysis
parallel, resumable and independently repairable.

This amends ADR 0015's single bounded Workspace planning Target. It does not
restore plan shards: Source Briefs cannot choose pages, owners or dependencies,
and there is no Compose Gate. The Page Plan remains one atomic Workspace
decision. The Run contract changes from `target-dag` to `source-plan-dag`;
legacy Run state is rejected without migration or compatibility branches, and
the OKF version is unchanged.

Considered: hide scouts inside one `plan:workspace` worker session. Rejected
because scout retries, budgets, packets and refresh invalidation would vanish
into conversation state. Considered: one Page Plan shard per Source. Rejected
because duplicate concepts and cross-Source lifecycles would require a second
plan merge contract. Considered: one scout for every Catalog. Rejected because
captured table indexes are already bounded structured inputs to Workspace
planning.
