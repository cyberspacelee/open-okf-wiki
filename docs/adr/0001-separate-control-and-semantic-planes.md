# Separate deterministic control from semantic execution

The OKF Knowledge Bundle Producer owns source snapshots, obligations, evidence acceptance, coverage, validation, and publication in a framework-independent Deterministic Control Plane. PydanticAI is the initial Agent Runner for the Semantic Execution Plane because it can reuse the enterprise OpenAI-compatible endpoint while providing tool execution, context management, retries, structured output, evaluation, and tracing; its message history and workflow state are not authoritative business state.
