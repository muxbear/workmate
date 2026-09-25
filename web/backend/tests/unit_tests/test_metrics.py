"""指标注册表与 Prometheus 文本格式（迭代 5 T5.5）。

指标的价值在于**被 Prometheus 成功抓取**——只要有一行格式不合法，整次抓取会被拒，
而失败是静默的（面板空着，没人知道为什么）。所以这里按**文本格式**逐行断言，而不是
只测"计数对不对"。

不引入 `prometheus_client` 的原因见模块文档：装不上依赖会让整个后端起不来，
可观测性设施不该成为可用性的单点。
"""

import pytest

from core.metrics import (
    Counter,
    Gauge,
    Histogram,
    render_prometheus,
)


@pytest.fixture(autouse=True)
def _isolate_registry():
    """每个用例用独立指标，避免互相污染（指标是全局单例）。"""
    yield


def _parse_labels(line: str) -> dict[str, str]:
    """把 ``name{a="1",b="2"} value`` 解析成标签字典——顺便校验语法。"""
    if "{" not in line:
        return {}
    raw = line.split("{", 1)[1].split("}", 1)[0]
    labels = {}
    for pair in raw.split(","):
        key, _, value = pair.partition("=")
        assert key and value.startswith('"') and value.endswith('"'), f"标签语法错误: {pair}"
        labels[key] = value.strip('"')
    return labels


class TestCounter:
    def test_counts_accumulate_per_label(self):
        counter = Counter("t_counter_total", "帮助", ("result",))
        counter.labels(result="success").inc()
        counter.labels(result="success").inc(2)
        counter.labels(result="failed").inc()

        out = "\n".join(counter.render())
        assert 't_counter_total{result="success"} 3' in out
        assert 't_counter_total{result="failed"} 1' in out

    def test_has_help_and_type_lines(self):
        counter = Counter("t_counter2_total", "帮助文本")
        lines = counter.render()

        assert lines[0] == "# HELP t_counter2_total 帮助文本"
        assert lines[1] == "# TYPE t_counter2_total counter"

    def test_declared_labels_are_enforced(self):
        """标签名写错要立刻报错，而不是静默生成一条没人看的序列。"""
        counter = Counter("t_counter3_total", "帮助", ("mode",))

        with pytest.raises(ValueError, match="需要标签"):
            counter.labels(mod="hybrid")


class TestHistogram:
    def test_buckets_are_cumulative(self):
        """``le`` 语义是"小于等于"：观测值会落进所有 >= 它的桶。"""
        hist = Histogram("t_hist", "帮助", buckets=(1.0, 2.0, 5.0))
        hist.labels().observe(0.5)
        hist.labels().observe(1.5)

        out = "\n".join(hist.render())
        assert 't_hist_bucket{le="1.0"} 1' in out
        assert 't_hist_bucket{le="2.0"} 2' in out
        assert 't_hist_bucket{le="5.0"} 2' in out
        assert 't_hist_bucket{le="+Inf"} 2' in out
        assert "t_hist_count 2" in out
        assert "t_hist_sum 2" in out  # 整数不带小数点

    def test_labeled_histogram_lines_are_valid_prometheus(self):
        """回归：``+Inf`` 桶此前漏了逗号，生成 ``{stage="x"le="+Inf"}``——
        Prometheus 会拒绝整次抓取，而面板只是空着，很难查到原因。"""
        hist = Histogram("t_hist2", "帮助", ("stage",), buckets=(1.0,))
        hist.labels(stage="embedding").observe(0.5)

        for line in hist.render():
            if line.startswith("#"):
                continue
            _parse_labels(line)  # 语法不合法就抛
            assert 'le="+Inf"' not in line or "," in line.split("{")[1].split("}")[0] or line.count('"') == 2

    def test_boundary_value_goes_into_its_bucket(self):
        hist = Histogram("t_hist3", "帮助", buckets=(1.0,))
        hist.labels().observe(1.0)

        assert 't_hist3_bucket{le="1.0"} 1' in "\n".join(hist.render())


class TestGauge:
    def test_set_overwrites(self):
        gauge = Gauge("t_gauge", "帮助")
        gauge.set(5)
        gauge.set(2)

        assert "t_gauge 2" in "\n".join(gauge.render())


class TestRenderPrometheus:
    def test_output_is_parseable_shaped(self):
        """整体输出：每行都是 ``指标名[标签] 值`` 或注释，且以换行结尾。"""
        counter = Counter("t_render_total", "帮助", ("mode",))
        counter.labels(mode="hybrid").inc()
        hist = Histogram("t_render_seconds", "帮助", ("mode",), buckets=(0.1,))
        hist.labels(mode="hybrid").observe(0.05)

        text = render_prometheus()

        assert text.endswith("\n")
        for line in text.strip().split("\n"):
            if line.startswith("#"):
                continue
            name_part, _, value = line.rpartition(" ")
            assert name_part and value, f"行格式异常: {line}"
            float(value)  # 值必须是数字
            _parse_labels(line)

    def test_labeled_metric_rejects_direct_calls(self):
        """带标签的指标直接 set/inc 会写进一条谁也查不到的空标签序列，必须报错。"""
        counter = Counter("t_direct_total", "帮助", ("mode",))

        with pytest.raises(ValueError, match="请先 labels"):
            counter.inc()

    def test_no_user_input_in_labels(self):
        """标签取值必须来自有限集合——高基数标签会把 Prometheus 打爆。"""
        from core.metrics import KB_SEARCH_REQUESTS, KB_STAGE_SECONDS

        assert set(KB_SEARCH_REQUESTS.labelnames) == {"mode", "result"}
        assert set(KB_STAGE_SECONDS.labelnames) == {"stage"}
