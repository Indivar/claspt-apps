# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.
"""OpenAI Agents SDK function tools from the shared tool specs. Needs `openai-agents`."""

from typing import Any, List

from ..client import Claspt
from ..tools import tool_specs


def tools(client: Claspt, namespace: str) -> List[Any]:
    try:
        from agents import function_tool
    except ImportError as e:  # pragma: no cover
        raise ImportError("pip install claspt[openai-agents]") from e
    out = []
    for spec in tool_specs(client, namespace):
        out.append(function_tool(spec.run, name_override=spec.name, description_override=spec.description))
    return out
