"""单 Agent + 单 Task 的 Crew 构建（编年史各槽位共用，CrewAI 0.86）。"""
from __future__ import annotations

from typing import Any

from crewai import Agent, Crew, Process, Task

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources, resolve_llm_for_run


def make_single_agent_crew(
    res: AgentLLMResources,
    *,
    role: str,
    goal: str,
    backstory: str,
    tools: list[Any],
    task_description: str,
    expected_output: str,
    max_iter: int = 25,
    llm_overrides: dict[str, Any] | None = None,
) -> Crew:
    if llm_overrides:
        llm = resolve_llm_for_run(res, llm_overrides)
    else:
        llm = res.llm
    agent = Agent(
        role=role,
        goal=goal,
        backstory=backstory,
        llm=llm,
        tools=tools or [],
        verbose=False,
        allow_delegation=False,
        max_iter=max_iter,
    )
    task = Task(
        description=task_description,
        expected_output=expected_output,
        agent=agent,
    )
    return Crew(
        agents=[agent],
        tasks=[task],
        verbose=False,
        max_iter=max_iter,
        process=Process.sequential,
    )
