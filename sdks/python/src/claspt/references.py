# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.
"""`claspt://secret/<page>?block=<label>#<field>` references, parsed and made."""

from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote, unquote

PREFIX = "claspt://secret/"


@dataclass(frozen=True)
class SecretReference:
    page: str
    field: str
    block: Optional[str] = None

    def to_uri(self) -> str:
        uri = PREFIX + "/".join(quote(seg, safe="") for seg in self.page.split("/"))
        if self.block is not None:
            uri += "?block=" + quote(self.block, safe="")
        return uri + "#" + quote(self.field, safe="")


def parse_reference(text: str) -> SecretReference:
    """The reference in `text`, or a ValueError naming what is wrong."""
    if not text.startswith(PREFIX):
        raise ValueError(f"not a secret reference (expected {PREFIX}...): {text}")
    rest = text[len(PREFIX):]
    if "#" not in rest:
        raise ValueError(f"reference has no #field: {text}")
    before, field = rest.rsplit("#", 1)
    page, _, query = before.partition("?")
    page, field = unquote(page), unquote(field)
    if not page or not field:
        raise ValueError(f"reference needs a page and a field: {text}")
    block = None
    for pair in filter(None, query.split("&")):
        key, _, value = pair.partition("=")
        if key == "block":
            block = unquote(value)
        else:
            raise ValueError(f"unknown reference option '{pair}' in {text}")
    return SecretReference(page=page, field=field, block=block)
