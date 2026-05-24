"""
Eenvoudige logger die zowel naar terminal als naar bot.log schrijft.

Voor de leerfase houden we het simpel — geen rotating files, geen JSON-formatter.
Tekstregels met tijdstempel volstaan; bot.log = bewijslast van wat de bot deed.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from config import ROOT

LOG_FILE = ROOT / "bot.log"


def get_logger(name: str = "bot") -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger  # al geconfigureerd

    logger.setLevel(logging.INFO)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )

    file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(fmt)
    logger.addHandler(stream_handler)

    return logger
