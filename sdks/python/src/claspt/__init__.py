# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.
"""Client for the Claspt local API."""

from .client import Claspt, ClasptError
from .references import SecretReference, parse_reference

__all__ = ["Claspt", "ClasptError", "SecretReference", "parse_reference"]
__version__ = "0.1.0"
