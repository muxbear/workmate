"""``agent.models`` 包的导出与懒加载语义。

对话模型**没有**模块级单例：它必须按请求从「模型」页面解析
（见 ``agent.models.resolver``），因此这里断言 ``llm`` 属性不存在，
并覆盖 embeddings 的懒加载行为。
"""

import importlib
import os

import pytest
from langchain_openai import OpenAIEmbeddings

import agent.models as models


def test_llm_singleton_is_gone():
    """回归护栏：不得再出现模块级 llm 单例（否则会绕过「模型」页面配置）。"""
    with pytest.raises(AttributeError):
        _ = models.llm


def test_unknown_attribute_raises_attribute_error():
    """未知属性如实报 AttributeError，而不是静默返回 None。"""
    with pytest.raises(AttributeError, match="agent.models"):
        _ = models.not_a_real_model


def test_embeddings_is_the_only_export():
    """embeddings 仍通过懒加载导出。"""
    assert models.__all__ == ["embeddings"]


@pytest.mark.skipif(
    not os.getenv("DASHSCOPE_API_KEY"),
    reason="需要 DASHSCOPE_API_KEY 才能构造 embedding 客户端",
)
def test_embeddings_lazy_export():
    """配置了凭证时，``embeddings`` 懒加载出 OpenAIEmbeddings 实例。"""
    module = importlib.import_module("agent.models")
    assert isinstance(module.embeddings, OpenAIEmbeddings)
