def text_embedding(text: str = '', model: str = 'text-embedding-v4') -> dict:
    return {'error': 'text_embedding tool not configured', 'text': text}

__all__ = ['text_embedding']
