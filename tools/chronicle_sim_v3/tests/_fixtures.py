"""测试公用 fixture 工厂。

三层架构后：make_stub_run 同时写 providers.yaml + llm.yaml + agents.yaml，
保证 EngineServices.agents（AgentService）能被 cli/cook._build_engine 装上。
"""
from __future__ import annotations

import textwrap
from pathlib import Path


_STUB_PROVIDERS_YAML = """\
schema: chronicle_sim_v3/providers@1
providers:
  stub_local:
    kind: stub
"""


_STUB_LLM_YAML = """\
schema: chronicle_sim_v3/llm@1
models:
  stub:
    provider: stub_local
    invocation: stub
  embed-stub:
    provider: stub_local
    invocation: stub
routes:
  offline: stub
  smart: stub
  fast: stub
  embed: embed-stub
cache:
  enabled: true
  default_mode: off
  per_route:
    offline: hash
    embed: hash
audit:
  enabled: true
  log_user_prompt: true
stub:
  fixed_seed: 7
providers_ref: config/providers.yaml
"""


_STUB_AGENTS_YAML = """\
schema: chronicle_sim_v3/agents@1
agents:
  cline_default:
    runner: cline
    provider: stub_local
    model_id: stub-smart
    timeout_sec: 60
  cline_offline:
    runner: cline
    provider: stub_local
    model_id: stub-offline
    timeout_sec: 60
  react_default:
    runner: react
    llm_route: smart
    timeout_sec: 60
    config:
      max_iter: 4
      tools: ["read_key", "final"]
routes:
  npc: cline_default
  director: cline_default
  gm: cline_default
  rumor: cline_default
  summary: cline_default
  initializer: cline_default
  probe: cline_default
limiter:
  per_runner:
    cline: 2
    simple_chat: 4
    react: 2
    external: 1
cache:
  enabled: true
  default_mode: off
audit:
  enabled: true
  log_user_prompt: true
"""


def make_stub_run(tmp_path: Path) -> Path:
    """造一个最小 Run 目录：providers / llm / agents 都是 stub。

    `cline_default` 在 stub run 中走 runner=cline + provider.kind=stub，
    由 ClineRunner 的离线 stub 分支返回稳定结果，避免触发真实 cline 子进程。
    """
    run = tmp_path / "run_stub"
    cfg = run / "config"
    cfg.mkdir(parents=True)
    (cfg / "providers.yaml").write_text(
        textwrap.dedent(_STUB_PROVIDERS_YAML), encoding="utf-8"
    )
    (cfg / "llm.yaml").write_text(
        textwrap.dedent(_STUB_LLM_YAML), encoding="utf-8"
    )
    (cfg / "agents.yaml").write_text(
        textwrap.dedent(_STUB_AGENTS_YAML), encoding="utf-8"
    )
    return run
