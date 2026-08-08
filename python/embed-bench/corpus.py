from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

TARGET_CHUNK_CHARS = 1200
MAX_CHUNK_CHARS = 2000

_HEADING_RE = re.compile(r"^#{1,6}\s+(.*)$")


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    source_path: str
    heading: str
    text: str


def _split_sections(markdown_text: str) -> list[tuple[str, str]]:
    """Split markdown into (heading, body) sections. Preamble before the
    first heading uses heading=''; dropped if empty."""
    sections: list[tuple[str, list[str]]] = [("", [])]
    for line in markdown_text.splitlines():
        match = _HEADING_RE.match(line)
        if match:
            sections.append((match.group(1).strip(), []))
        else:
            sections[-1][1].append(line)
    return [(heading, "\n".join(lines).strip()) for heading, lines in sections if "\n".join(lines).strip()]


def _split_paragraphs(body: str) -> list[str]:
    return [p.strip() for p in body.split("\n\n") if p.strip()]


def _pack_paragraphs(paragraphs: list[str]) -> list[str]:
    """Greedily pack paragraphs into chunks near TARGET_CHUNK_CHARS, never
    exceeding MAX_CHUNK_CHARS. A single paragraph longer than MAX_CHUNK_CHARS
    is hard-split (character slicing) so no output chunk ever exceeds the cap."""
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for paragraph in paragraphs:
        if current and current_len + len(paragraph) > MAX_CHUNK_CHARS:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0
        if len(paragraph) > MAX_CHUNK_CHARS:
            # Oversized single paragraph: flush whatever's pending, then
            # hard-split this paragraph into MAX_CHUNK_CHARS-sized pieces.
            if current:
                chunks.append("\n\n".join(current))
                current = []
                current_len = 0
            for start in range(0, len(paragraph), MAX_CHUNK_CHARS):
                chunks.append(paragraph[start : start + MAX_CHUNK_CHARS])
            continue
        current.append(paragraph)
        current_len += len(paragraph)
        if current_len >= TARGET_CHUNK_CHARS:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def chunk_markdown_file(path: Path, root: Path) -> list[Chunk]:
    text = path.read_text(encoding="utf-8")
    relative_path = str(path.relative_to(root))
    chunks: list[Chunk] = []
    index = 0
    for heading, body in _split_sections(text):
        paragraphs = _split_paragraphs(body)
        for chunk_text in _pack_paragraphs(paragraphs):
            chunk_id = f"{relative_path}::{heading or 'root'}::{index}"
            chunks.append(Chunk(chunk_id=chunk_id, source_path=relative_path, heading=heading, text=chunk_text))
            index += 1
    return chunks


def load_and_chunk(dirs: list[Path]) -> list[Chunk]:
    all_chunks: list[Chunk] = []
    for directory in dirs:
        for path in sorted(directory.rglob("*.md")):
            all_chunks.extend(chunk_markdown_file(path, directory))
    return all_chunks
