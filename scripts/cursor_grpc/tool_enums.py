"""Subset of ClientSideToolV2 for agent request supported_tools."""

from __future__ import annotations


class ClientSideToolV2:
    READ_FILE = 5
    LIST_DIR = 6
    EDIT_FILE = 7
    FILE_SEARCH = 8
    RUN_TERMINAL_COMMAND_V2 = 15
    GLOB_FILE_SEARCH = 42
