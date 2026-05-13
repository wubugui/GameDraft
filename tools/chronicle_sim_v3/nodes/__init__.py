"""节点抽屉总入口；import 各子模块触发 @register_node。

P1 范围（23 个）：
- io: read.world.setting / read.world.agents / read.chronicle.events
- data: filter.where / map.expr / sort.by / take.n / count / list.concat / dict.merge
- text: template.render / text.concat / json.encode / json.decode
- math: math.compare / math.range
- random: rng.from_seed
- npc: npc.filter_active / npc.partition_by_tier
- flow: flow.foreach / flow.fanout_per_agent / flow.parallel / flow.when / flow.merge / flow.subgraph (P1-6)
- agent: agent.cline (P1-6)
"""
from __future__ import annotations

from tools.chronicle_sim_v3.nodes import io as _io  # noqa: F401
from tools.chronicle_sim_v3.nodes import data as _data  # noqa: F401
from tools.chronicle_sim_v3.nodes import text as _text  # noqa: F401
from tools.chronicle_sim_v3.nodes import math as _math  # noqa: F401
from tools.chronicle_sim_v3.nodes import random as _random  # noqa: F401
from tools.chronicle_sim_v3.nodes import npc as _npc  # noqa: F401
from tools.chronicle_sim_v3.nodes import flow as _flow  # noqa: F401
from tools.chronicle_sim_v3.nodes import agent as _agent  # noqa: F401
from tools.chronicle_sim_v3.nodes import event as _event  # noqa: F401
from tools.chronicle_sim_v3.nodes import eventtype as _eventtype  # noqa: F401
from tools.chronicle_sim_v3.nodes import pacing as _pacing  # noqa: F401
from tools.chronicle_sim_v3.nodes import social as _social  # noqa: F401
from tools.chronicle_sim_v3.nodes import rumor as _rumor  # noqa: F401
from tools.chronicle_sim_v3.nodes import belief as _belief  # noqa: F401
from tools.chronicle_sim_v3.nodes import tier as _tier  # noqa: F401
from tools.chronicle_sim_v3.nodes import chroma as _chroma  # noqa: F401
