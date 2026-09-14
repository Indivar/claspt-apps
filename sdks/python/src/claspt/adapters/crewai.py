# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.
"""CrewAI tools from the shared tool specs. Needs `crewai`."""

from typing import Any, List

from ..client import Claspt
from ..tools import tool_specs


def tools(client: Claspt, namespace: str) -> List[Any]:
    try:
        from crewai.tools import tool as crewai_tool
    except ImportError as e:  # pragma: no cover
        raise ImportError("pip install claspt[crewai]") from e
    out = []
    for spec in tool_specs(client, namespace):
        fn = spec.run
        fn.__name__ = spec.name
        fn.__doc__ = spec.description
        out.append(crewai_tool(spec.name)(fn))
    return out
