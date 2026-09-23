"""Tests for core.rag.text_analyzer — CJK 友好的分词。"""

from core.rag.text_analyzer import (
    term_frequencies,
    tokenize,
    tokenize_query,
)


class TestTokenize:
    def test_chinese_produces_unigrams_and_bigrams(self):
        """中文切出单字 + 相邻二元组（旧实现整句一个 token，导致无法命中）。"""
        assert tokenize("向量数据库") == [
            "向", "量", "数", "据", "库",
            "向量", "量数", "数据", "据库",
        ]

    def test_chinese_terms_are_not_glued_into_one_token(self):
        """核心回归：中文查询必须切成多个 token。"""
        tokens = tokenize("什么是机器学习")
        assert len(tokens) > 1
        assert "什么是机器学习" not in tokens

    def test_single_cjk_char(self):
        """单字片段只产出自身，不产出跨越标点的伪二元组。"""
        assert tokenize("好") == ["好"]

    def test_latin_words_lowercased(self):
        """拉丁词统一小写，保证大小写不敏感匹配。"""
        assert tokenize("RAG System") == ["rag", "system"]

    def test_digits_kept_with_chinese(self):
        """数字与中文分开切片。"""
        assert tokenize("2024年") == ["2024", "年"]

    def test_bigrams_do_not_cross_punctuation(self):
        """二元组只在连续 CJK 片段内生成，不跨越标点。"""
        tokens = tokenize("数据，库")
        assert "据库" not in tokens
        assert "数据" in tokens
        assert "库" in tokens

    def test_mixed_text(self):
        """中英混合文本同时产出两类 token。"""
        tokens = tokenize("使用 Milvus 做向量检索")
        assert "milvus" in tokens
        assert "向量" in tokens
        assert "检索" in tokens

    def test_empty_input(self):
        assert tokenize("") == []

    def test_whitespace_only(self):
        assert tokenize("   ") == []

    def test_alphanumeric_word(self):
        assert tokenize("text_embedding_v4") == ["text_embedding_v4"]


class TestTermFrequencies:
    def test_counts_repeated_terms(self):
        freqs = term_frequencies("向量向量")
        assert freqs["向量"] == 2
        assert freqs["向"] == 2

    def test_empty(self):
        assert term_frequencies("") == {}


class TestTokenizeQuery:
    def test_deduplicates_query_terms(self):
        """查询侧去重，避免重复 token 反复加权。"""
        terms = tokenize_query("向量 向量")
        assert terms.count("向量") == 1

    def test_preserves_first_seen_order(self):
        terms = tokenize_query("数据库")
        assert terms[0] == "数据"

    def test_empty(self):
        assert tokenize_query("") == []

    def test_no_unigrams_for_multi_char_run(self):
        """长度 ≥2 的 CJK 片段不产出单字——避免跨词误召回。

        若查询「量子纠缠」产出单字「量」，就会命中所有含「向量」的切片。
        """
        terms = tokenize_query("量子纠缠")
        assert terms == ["量子", "子纠", "纠缠"]
        assert "量" not in terms

    def test_single_char_query_still_tokenized(self):
        """单词查询仍需保留单字，配合文档侧单字保证召回。"""
        assert tokenize_query("库") == ["库"]

    def test_query_terms_are_subset_of_document_terms(self):
        """查询侧 token 必须都能在文档侧口径中找到，否则永远无法命中。"""
        text = "向量数据库用于相似度检索"
        doc_terms = set(tokenize(text))
        for term in tokenize_query(text):
            assert term in doc_terms

    def test_latin_terms_shared_by_both_sides(self):
        """拉丁词两侧口径一致。"""
        assert tokenize_query("Milvus 检索")[0] == "milvus"
