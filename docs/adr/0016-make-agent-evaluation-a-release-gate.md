# Make agent evaluation a release gate

The MVP evaluates Planner, Worker, Verifier, and Renderer roles independently, inspects their tool trajectories, runs end-to-end and Mutation Case evaluations over the Benchmark Corpus, and samples production outcomes for offline review. Deterministic code remains covered by ordinary tests, while `pydantic-evals`, gold comparisons, semantic judges, and human adjudication gate changes to models, prompts, tools, classifiers, Agent workflows, Producer Profiles, and knowledge schemas.
