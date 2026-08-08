from corpus import chunk_markdown_file, load_and_chunk


def test_chunk_markdown_file_single_short_section(tmp_path):
    md_path = tmp_path / "doc.md"
    md_path.write_text("# Title\n\nA short paragraph about MLX embeddings.\n", encoding="utf-8")

    chunks = chunk_markdown_file(md_path, tmp_path)

    assert len(chunks) == 1
    assert chunks[0].source_path == "doc.md"
    assert chunks[0].heading == "Title"
    assert "MLX embeddings" in chunks[0].text
    assert chunks[0].chunk_id == "doc.md::Title::0"


def test_chunk_markdown_file_splits_long_section(tmp_path):
    md_path = tmp_path / "long.md"
    paragraph = "Paragraph about local embedding servers. " * 40  # ~1720 chars
    body = "\n\n".join([paragraph] * 3)
    md_path.write_text(f"# Long Section\n\n{body}\n", encoding="utf-8")

    chunks = chunk_markdown_file(md_path, tmp_path)

    assert len(chunks) >= 2
    assert all(len(c.text) <= 2000 for c in chunks)
    assert all(c.heading == "Long Section" for c in chunks)


def test_chunk_markdown_file_ignores_text_before_first_heading_if_empty(tmp_path):
    md_path = tmp_path / "preamble.md"
    md_path.write_text("\n\n# Real Section\n\nSome content here.\n", encoding="utf-8")

    chunks = chunk_markdown_file(md_path, tmp_path)

    assert len(chunks) == 1
    assert chunks[0].heading == "Real Section"


def test_load_and_chunk_scans_all_markdown_files_recursively(tmp_path):
    (tmp_path / "a.md").write_text("# A\n\nContent A.\n", encoding="utf-8")
    subdir = tmp_path / "nested"
    subdir.mkdir()
    (subdir / "b.md").write_text("# B\n\nContent B.\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("ignored", encoding="utf-8")

    chunks = load_and_chunk([tmp_path])

    assert {c.source_path for c in chunks} == {"a.md", "nested/b.md"}
