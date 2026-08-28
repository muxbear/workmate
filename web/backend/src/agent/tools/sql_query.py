def sql_query(query: str = '', database_url: str = '') -> dict:
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
