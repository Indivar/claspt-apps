# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.
"""LangChain tools from the shared tool specs. Needs `langchain-core`."""

from typing import Any, List

from ..client import Claspt
from ..tools import tool_specs


def tools(client: Claspt, namespace: str) -> List[Any]:
    try:
        from langchain_core.tools import StructuredTool
    except ImportError as e:  # pragma: no cover - exercised by the missing-extra test
        raise ImportError("pip install claspt[langchain]") from e
    return [
        StructuredTool.from_function(func=spec.run, name=spec.name, description=spec.description)
        for spec in tool_specs(client, namespace)
    ]
