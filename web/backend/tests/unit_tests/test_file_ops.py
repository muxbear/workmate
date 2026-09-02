"""文件读写工具单元测试。"""

from agent.tools.file_ops import read_file, write_file


def test_write_file_creates_parent_dirs_and_reads_back(tmp_path):
    """write_file 应自动创建父目录，read_file 应能读回内容。"""
    target = tmp_path / "nested" / "hello.txt"

    result = write_file(str(target), "你好，世界")

    assert result["success"] is True
    assert result["path"] == str(target)
    assert read_file(str(target))["content"] == "你好，世界"


def test_write_file_default_mode_overwrites(tmp_path):
    """默认覆盖模式应替换已有文件内容。"""
    target = tmp_path / "sample.txt"
    write_file(str(target), "first")

    result = write_file(str(target), "second")

    assert result["success"] is True
    assert read_file(str(target))["content"] == "second"


def test_write_file_append_mode(tmp_path):
    """追加模式应在已有内容后追加而不是覆盖。"""
    target = tmp_path / "log.txt"
    write_file(str(target), "line1\n")

    result = write_file(str(target), "line2\n", mode="append")

    assert result["success"] is True
    assert read_file(str(target))["content"] == "line1\nline2\n"


def test_write_file_reports_failure_for_invalid_encoding(tmp_path):
    """写入失败时应返回 error 且 success 为 False。"""
    target = tmp_path / "bad.txt"

    result = write_file(str(target), "hello", encoding="not-a-real-encoding")

    assert result["success"] is False
    assert "error" in result


def test_read_file_reports_missing_file(tmp_path):
    """读取不存在的文件应返回 error 而非抛出异常。"""
    missing = tmp_path / "missing.txt"

    result = read_file(str(missing))

    assert result["content"] == ""
    assert "error" in result