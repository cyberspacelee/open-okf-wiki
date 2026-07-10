import asyncio

from pydantic_ai import Agent, UsageLimits
from pydantic_ai.models import Model

from .scheduler import PlannerSummary, TaskPlan


class PlannerAgent:
    def __init__(
        self,
        model: Model,
        *,
        request_limit: int = 3,
        input_tokens_limit: int = 12_000,
        output_tokens_limit: int = 4_000,
        wall_time_seconds: float = 30,
    ) -> None:
        self.model = model
        self.usage_limits = UsageLimits(
            request_limit=request_limit,
            input_tokens_limit=input_tokens_limit,
            output_tokens_limit=output_tokens_limit,
        )
        self.wall_time_seconds = wall_time_seconds

    async def plan(self, summary: PlannerSummary) -> TaskPlan:
        agent = Agent[None, TaskPlan](
            self.model,
            name="planner_agent",
            output_type=TaskPlan,
            instructions=(
                "Return bounded Analysis Tasks for the prioritized uncovered obligations. "
                "Use only supplied source IDs and paths. Do not create Agents or retain state."
            ),
            retries={"output": 1},
            max_concurrency=1,
        )
        async with asyncio.timeout(self.wall_time_seconds):
            result = await agent.run(
                summary.model_dump_json(),
                usage_limits=self.usage_limits,
                metadata={"run_id": summary.run_id, "agent_role": "planner"},
            )
        return result.output
