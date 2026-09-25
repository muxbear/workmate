"""极简指标注册表——以 Prometheus 文本格式暴露（迭代 5 T5.5）。

**为什么不引入 `prometheus_client`**：本项目部署环境未必能装新依赖，而"装不上"
的后果是整个后端起不来——可观测性设施不该成为服务可用性的单点。这里只实现
Prometheus 文本格式需要的三种原语（counter / gauge / histogram），几十行、可单测；
将来若要换成官方客户端，``render_prometheus()`` 的替换是局部的。

约定：
- 指标名一律 ``kb_`` 前缀 + 下划线；
- 标签值只在**有限集合**里取（模式名、阶段名、结果），不给用户输入打标签——
  高基数标签会把 Prometheus 打爆（每个不同的 query 都生成一条时间序列）。

用法::

    INDEX_TASKS.labels(result="success").inc()
    STAGE_SECONDS.labels(stage="embedding").observe(elapsed)
    QUEUE_DEPTH.set(len(queue))
"""

from __future__ import annotations

import threading
from collections import defaultdict

#: 使用内置的默认桶（秒）——覆盖"毫秒级检索"到"分钟级索引阶段"
DEFAULT_BUCKETS: tuple[float, ...] = (
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0,
)


class _Metric:
    """公共部分：名称、说明、标签键、以及"取子指标"的线程安全字典。"""

    def __init__(self, name: str, help_text: str, labelnames: tuple[str, ...] = ()):
        self.name = name
        self.help = help_text
        self.labelnames = labelnames
        self._lock = threading.Lock()
        self._values: dict[tuple[str, ...], float] = defaultdict(float)

    def labels(self, **kwargs: str) -> _Metric:
        """按标签取（或创建）子指标；标签键必须与声明一致。"""
        if set(kwargs) != set(self.labelnames):
            raise ValueError(
                f"{self.name} 需要标签 {self.labelnames}，收到 {tuple(kwargs)}",
            )
        key = tuple(str(kwargs[name]) for name in self.labelnames)
        with self._lock:
            self._values.setdefault(key, 0.0)
        return _BoundMetric(self, key)

    def _ensure_no_labels(self, method: str) -> None:
        """无标签指标可以直接 ``gauge.set(x)``；有标签的必须先 ``labels(...)``。

        直接对带标签的指标调用会写进一条空标签序列——那条序列谁也查不到，
        却会一直留在 /metrics 里让人困惑，所以直接报错。
        """
        if self.labelnames:
            raise ValueError(
                f"{self.name} 需要标签 {self.labelnames}，请先 labels(...) 再 {method}",
            )

    def inc(self, amount: float = 1.0) -> None:
        """计数类指标的便捷入口（无标签时使用）。"""
        self._ensure_no_labels("inc")
        self._add((), amount)

    def set(self, value: float) -> None:
        """Gauge 的便捷入口（无标签时使用）。"""
        self._ensure_no_labels("set")
        self._set((), value)

    def _add(self, key: tuple[str, ...], amount: float) -> None:
        with self._lock:
            self._values[key] += amount

    def _set(self, key: tuple[str, ...], value: float) -> None:
        with self._lock:
            self._values[key] = value

    def _snapshot(self) -> list[tuple[tuple[str, ...], float]]:
        with self._lock:
            return sorted(self._values.items())

    def _label_suffix(self, key: tuple[str, ...]) -> str:
        if not self.labelnames:
            return ""
        pairs = ",".join(f'{n}="{v}"' for n, v in zip(self.labelnames, key))
        return "{" + pairs + "}"

    def render(self) -> list[str]:
        raise NotImplementedError


class Counter(_Metric):
    """只增不减的计数（成功数、失败数、调用数）。"""

    def render(self) -> list[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} counter"]
        for key, value in self._snapshot():
            lines.append(f"{self.name}{self._label_suffix(key)} {_fmt(value)}")
        return lines


class Gauge(_Metric):
    """可增可减的瞬时值（队列深度、就绪状态）。"""

    def render(self) -> list[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} gauge"]
        for key, value in self._snapshot():
            lines.append(f"{self.name}{self._label_suffix(key)} {_fmt(value)}")
        return lines


class Histogram(_Metric):
    """分桶直方图（耗时分布）。

    每个观测值会累加到所有下界 >= 它的桶里（Prometheus 的 ``le`` 语义是"小于等于"），
    外加 ``_count`` 与 ``_sum``——这正是 Prometheus 计算分位数所需要的全部信息。
    """

    def __init__(
        self, name: str, help_text: str, labelnames: tuple[str, ...] = (),
        buckets: tuple[float, ...] = DEFAULT_BUCKETS,
    ):
        super().__init__(name, help_text, labelnames)
        self.buckets = tuple(sorted(buckets))
        self._counts: dict[tuple[str, ...], list[int]] = defaultdict(
            lambda: [0] * (len(self.buckets) + 1),   # 末位是 +Inf
        )
        self._sums: dict[tuple[str, ...], float] = defaultdict(float)

    def observe(self, value: float) -> None:
        """记录一次观测（无标签时直接用；有标签时先 ``labels(...)``）。"""
        self._ensure_no_labels("observe")
        self._observe((), value)

    def _observe(self, key: tuple[str, ...], value: float) -> None:
        with self._lock:
            counts = self._counts[key]
            for index, bound in enumerate(self.buckets):
                if value <= bound:
                    counts[index] += 1
            counts[-1] += 1
            self._sums[key] += value

    def render(self) -> list[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} histogram"]
        with self._lock:
            keys = sorted(set(self._counts) | set(self._sums))
            for key in keys:
                counts = self._counts.get(key, [0] * (len(self.buckets) + 1))
                for bound, count in zip(self.buckets, counts):
                    suffix = self._label_suffix(key)
                    label = f'le="{bound}"'
                    merged = (
                        suffix[:-1] + "," + label + "}" if suffix else "{" + label + "}"
                    )
                    lines.append(f"{self.name}_bucket{merged} {count}")
                suffix = self._label_suffix(key)
                # 注意别漏逗号：`{stage="x"le="+Inf"}` 是非法行，Prometheus 解析器会拒绝
                merged = (
                    suffix[:-1] + ',le="+Inf"}' if suffix else '{le="+Inf"}'
                )
                lines.append(f"{self.name}_bucket{merged} {counts[-1]}")
                lines.append(f"{self.name}_sum{suffix} {_fmt(self._sums.get(key, 0.0))}")
                lines.append(f"{self.name}_count{suffix} {counts[-1]}")
        return lines


class _BoundMetric:
    """``labels(...)`` 的返回值——把调用绑到具体标签组合上。"""

    def __init__(self, metric: _Metric, key: tuple[str, ...]):
        self._metric = metric
        self._key = key

    def inc(self, amount: float = 1.0) -> None:
        self._metric._add(self._key, amount)

    def set(self, value: float) -> None:
        self._metric._set(self._key, value)

    def observe(self, value: float) -> None:
        observe = getattr(self._metric, "_observe", None)
        if observe is None:
            raise TypeError(f"{self._metric.name} 不是直方图，无法 observe")
        observe(self._key, value)


def _fmt(value: float) -> str:
    """数字格式：整数不带小数点，便于肉眼核对与 Prometheus 解析。"""
    if value == int(value):
        return str(int(value))
    return repr(float(value))


_REGISTRY: list[_Metric] = []


def register(metric: _Metric) -> _Metric:
    """登记指标（渲染时只输出登记过的）。"""
    if metric not in _REGISTRY:
        _REGISTRY.append(metric)
    return metric


def render_prometheus() -> str:
    """渲染全部指标为 Prometheus 文本格式（以 ``\\n`` 结尾）。"""
    lines: list[str] = []
    for metric in _REGISTRY:
        lines.extend(metric.render())
    return "\n".join(lines) + "\n"


def reset() -> None:
    """清空全部指标的取值（测试用；不摘除登记）。"""
    for metric in _REGISTRY:
        with metric._lock:
            metric._values.clear()
            if isinstance(metric, Histogram):
                metric._counts.clear()
                metric._sums.clear()


# ─── 知识库指标（单一事实来源；各处只引用这里的对象）─────────────────────────

KB_INDEX_TASKS = register(Counter(
    "kb_index_tasks_total", "索引任务终态计数", ("result",),
))
KB_STAGE_SECONDS = register(Histogram(
    "kb_index_stage_seconds", "索引各阶段耗时（秒）", ("stage",),
))
KB_INDEX_QUEUE_DEPTH = register(Gauge(
    "kb_index_queue_depth", "索引队列中排队与在跑的任务数",
))
KB_SEARCH_REQUESTS = register(Counter(
    "kb_search_requests_total", "检索请求数", ("mode", "result"),
))
KB_SEARCH_SECONDS = register(Histogram(
    "kb_search_seconds", "检索耗时（秒）", ("mode",),
))
KB_EMBEDDING_CALLS = register(Counter(
    "kb_embedding_calls_total", "embedding 调用（批次）数", ("result",),
))

__all__ = [
    "KB_EMBEDDING_CALLS",
    "KB_INDEX_QUEUE_DEPTH",
    "KB_INDEX_TASKS",
    "KB_SEARCH_REQUESTS",
    "KB_SEARCH_SECONDS",
    "KB_STAGE_SECONDS",
    "Counter",
    "Gauge",
    "Histogram",
    "register",
    "render_prometheus",
    "reset",
]
