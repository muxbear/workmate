"""SQL 查询工具——对 SQLite 库执行只读查询并返回结果集。."""


def sql_query(query: str = '', database_url: str = '') -> dict:
    """对 SQLite 数据库执行 SQL 查询并返回列名与结果行。.

    Args:
        query: 要执行的 SQL 语句。
        database_url: SQLite 数据库文件路径；留空则使用内存库。

    Returns:
        包含以下字段的字典：
            - columns: 结果集列名列表
            - rows: 结果行列表
            - count: 返回行数
            - error: 出错时的错误信息（成功时无此字段）
    """
    try:
        import sqlite3
        conn = sqlite3.connect(database_url or ':memory:')
        try:
            cur = conn.execute(query)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = [row for row in cur.fetchall()]
            return {'columns': cols, 'rows': rows, 'count': len(rows)}
        finally:
            conn.close()
    except Exception as e:
        return {'error': str(e)}

__all__ = ['sql_query']
