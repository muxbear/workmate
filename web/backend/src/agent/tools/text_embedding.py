"""文本向量化工具（占位实现）。."""


def text_embedding(text: str = '', model: str = 'text-embedding-v4') -> dict:
    """把文本转为向量表示（当前为占位实现，尚未接入向量化服务）。.

    模型只能从本工具拿到「未配置」的说明，无法用它完成检索或相似度计算；
    如需真正的向量化能力，应改用知识库检索工具（kb_search）。

    Args:
        text: 待向量化的文本。
        model: 期望使用的向量模型名称。

    Returns:
        包含以下字段的字典：
            - error: 固定为未配置的说明
            - text: 原样回显的输入文本
    """
    return {'error': 'text_embedding tool not configured', 'text': text}


__all__ = ['text_embedding']
