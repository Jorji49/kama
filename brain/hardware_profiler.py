"""
Aether Brain — Hardware Profiler & AI Model Recommender

Detects local PC specs (RAM, CPU, GPU/VRAM) and recommends the optimal
Ollama model based on available hardware resources.

Architecture: 100% LOCAL — reads system hardware, no network required.
"""

from __future__ import annotations

import platform
import subprocess
import logging
import os
import re
from dataclasses import dataclass, field

log = logging.getLogger("brain.hardware")

# ── Model Catalog with hardware requirements ──────────────────────────

@dataclass
class ModelSpec:
    name: str
    desc: str
    size_label: str       # human size string
    ram_gb: float         # minimum RAM to comfortably run
    vram_gb: float        # minimum VRAM if GPU-accelerated (0 = CPU-OK)
    quality_tier: int     # 1=fastest, 5=best quality
    speed_tier: int       # 1=slowest, 5=fastest
    specialty: str        # "general" | "code" | "reasoning" | "multilingual"
    tags: list[str] = field(default_factory=list)


MODEL_CATALOG: list[ModelSpec] = [
    # Ultra-light (runs on anything)
    ModelSpec("llama3.2-1b",    "Tiny, instant responses. Simple prompts.",            "1.3 GB",  3.0, 0, 1, 5, "general",     ["tiny", "fast"]),
    ModelSpec("deepseek-r1:1.5b","Reasoning-focused. Logic-heavy prompts.",             "1.1 GB",  3.0, 0, 2, 5, "reasoning",   ["tiny", "reasoning"]),
    ModelSpec("qwen2.5:1.5b",    "Efficient multilingual. Turkish/English.",            "986 MB",  2.5, 0, 2, 5, "multilingual",["tiny", "multilingual"]),

    # Small (4–6 GB RAM)
    ModelSpec("gemma2:2b",       "Fast — Quick prompt generation, low RAM.",            "1.6 GB",  4.0, 0, 2, 4, "general",     ["small", "balanced"]),
    ModelSpec("codegemma:2b",    "Code specialist. Tech-aware prompts.",                "1.6 GB",  4.0, 0, 2, 4, "code",        ["small", "code"]),
    ModelSpec("llama3.2-3b",    "Good speed/quality balance.",                         "2.0 GB",  5.0, 0, 2, 4, "general",     ["small", "balanced"]),

    # Medium (6–10 GB RAM, recommended mainstream)
    ModelSpec("gemma2-2b",      "Strong multilingual. Good balance.",                  "1.6 GB",  4.0, 0, 3, 3, "general",     ["medium", "recommended", "best-value"]),
    ModelSpec("deepseek-r1:7b",  "Advanced reasoning. Complex architectures.",          "4.7 GB",  8.0, 0, 4, 2, "reasoning",   ["medium", "reasoning"]),
    ModelSpec("llama3.1:8b",     "Powerful 8B. Excellent quality, needs 8GB+ RAM.",     "4.7 GB",  8.0, 0, 4, 2, "general",     ["medium", "quality"]),
    ModelSpec("mistral",         "Versatile 7B. Reliable quality.",                     "4.1 GB",  7.0, 0, 3, 3, "general",     ["medium", "versatile"]),
    ModelSpec("codellama:7b",    "Code specialist 7B. Deep understanding.",             "3.8 GB",  7.0, 0, 4, 3, "code",        ["medium", "code"]),
    ModelSpec("qwen2.5:7b",      "Strong multilingual 7B. Non-English prompts.",        "4.7 GB",  8.0, 0, 4, 2, "multilingual",["medium", "multilingual"]),
    ModelSpec("gemma2",          "Strong 7B. High quality, moderate speed.",            "5.4 GB",  8.0, 0, 4, 2, "general",     ["medium", "quality"]),

    # Large (12 GB+ RAM / 8 GB+ VRAM)
    ModelSpec("phi4",            "Best reasoning. Top quality, needs 12GB+ RAM.",       "9.1 GB", 14.0, 8.0, 5, 1, "reasoning",  ["large", "best-quality", "reasoning"]),
]


@dataclass
class HardwareInfo:
    os_name: str
    os_version: str
    cpu_name: str
    cpu_cores: int          # logical (including hyperthreading)
    cpu_physical: int       # physical cores
    ram_gb: float
    gpu_name: str
    vram_gb: float
    has_cuda: bool
    has_metal: bool         # Apple Silicon MPS
    platform_bits: str


@dataclass
class ModelRecommendation:
    name: str
    reason: str
    tier: str               # "optimal" | "fast" | "quality"
    quality_tier: int
    speed_tier: int
    ram_required: str
    already_installed: bool = False


@dataclass
class HardwareProfile:
    hardware: HardwareInfo
    recommendations: list[ModelRecommendation]
    warning: str            # any hardware limitation warning
    summary: str            # human-readable summary


# ── Hardware Detection ─────────────────────────────────────────────────

def _safe_int(v: object, default: int = 0) -> int:
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _detect_ram_gb() -> float:
    """Detect total system RAM in GB."""
    try:
        import psutil
        return round(psutil.virtual_memory().total / (1024 ** 3), 1)
    except ImportError:
        pass

    # Fallback: platform-specific
    sys = platform.system()
    try:
        if sys == "Windows":
            out = subprocess.check_output(
                ["wmic", "computersystem", "get", "TotalPhysicalMemory"],
                text=True, timeout=5
            )
            for line in out.splitlines():
                line = line.strip()
                if line.isdigit():
                    return round(int(line) / (1024 ** 3), 1)
        elif sys == "Linux":
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        kb = int(line.split()[1])
                        return round(kb / (1024 ** 2), 1)
        elif sys == "Darwin":
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True, timeout=5)
            return round(int(out.strip()) / (1024 ** 3), 1)
    except Exception as e:
        log.debug("RAM detection fallback error: %s", e)
    return 8.0  # safe default


def _detect_cpu() -> tuple[str, int, int]:
    """Returns (cpu_name, logical_cores, physical_cores)."""
    logical = os.cpu_count() or 4
    physical = logical

    try:
        import psutil
        physical = psutil.cpu_count(logical=False) or logical
        cpu_freq = psutil.cpu_freq()
    except ImportError:
        pass

    name = platform.processor() or "Unknown CPU"

    if not name or name in ("", "unknown"):
        sys = platform.system()
        try:
            if sys == "Windows":
                out = subprocess.check_output(
                    ["wmic", "cpu", "get", "Name"],
                    text=True, timeout=5
                )
                lines = [l.strip() for l in out.splitlines() if l.strip() and l.strip() != "Name"]
                name = lines[0] if lines else "Unknown CPU"
            elif sys == "Linux":
                with open("/proc/cpuinfo") as f:
                    for line in f:
                        if "model name" in line.lower():
                            name = line.split(":")[1].strip()
                            break
            elif sys == "Darwin":
                out = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True, timeout=5)
                name = out.strip()
        except Exception as e:
            log.debug("CPU name detection error: %s", e)

    return name[:80], logical, physical


def _detect_gpu() -> tuple[str, float, bool, bool]:
    """Returns (gpu_name, vram_gb, has_cuda, has_metal)."""
    gpu_name = "Unknown GPU"
    vram_gb = 0.0
    has_cuda = False
    has_metal = False

    sys = platform.system()

    # ── Apple Silicon check ──────────────────────────────────────────
    if sys == "Darwin":
        try:
            out = subprocess.check_output(["system_profiler", "SPDisplaysDataType"], text=True, timeout=10)
            if "Apple" in out:
                has_metal = True
                gpu_name = "Apple Silicon GPU"
                # Unified memory — share with RAM
                match = re.search(r"Total Number of Cores:\s*(\d+)", out)
                if match:
                    gpu_name = f"Apple Silicon GPU ({match.group(1)} cores)"
        except Exception as e:
            log.debug("macOS GPU detection error: %s", e)

    # ── NVIDIA via nvidia-smi ─────────────────────────────────────────
    if not has_metal:
        try:
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                text=True, timeout=8
            )
            line = out.strip().split("\n")[0]
            parts = line.split(",")
            if len(parts) >= 2:
                gpu_name = parts[0].strip()
                vram_gb = round(int(parts[1].strip()) / 1024, 1)
                has_cuda = True
        except (FileNotFoundError, subprocess.SubprocessError, ValueError) as e:
            log.debug("nvidia-smi error: %s", e)

    # ── AMD on Windows via WMIC ───────────────────────────────────────
    if not has_cuda and not has_metal and sys == "Windows":
        try:
            out = subprocess.check_output(
                ["wmic", "path", "win32_VideoController", "get",
                 "Name,AdapterRAM", "/value"],
                text=True, timeout=8
            )
            name_m = re.search(r"Name=(.+)", out)
            ram_m = re.search(r"AdapterRAM=(\d+)", out)
            if name_m:
                gpu_name = name_m.group(1).strip()[:60]
            if ram_m:
                vram_gb = round(int(ram_m.group(1)) / (1024 ** 3), 1)
        except Exception as e:
            log.debug("WMIC GPU detection error: %s", e)

    # ── AMD on Linux via lspci ────────────────────────────────────────
    if not has_cuda and not has_metal and sys == "Linux":
        try:
            out = subprocess.check_output(["lspci", "-v"], text=True, timeout=8)
            for line in out.splitlines():
                if "VGA" in line or "3D controller" in line:
                    gpu_name = line.split(":")[-1].strip()[:60]
                    break
        except Exception as e:
            log.debug("lspci GPU detection error: %s", e)

    return gpu_name, vram_gb, has_cuda, has_metal


def detect_hardware() -> HardwareInfo:
    """Detect all hardware specs. Never raises — returns safe defaults on any error."""
    try:
        ram_gb = _detect_ram_gb()
        cpu_name, logical, physical = _detect_cpu()
        gpu_name, vram_gb, has_cuda, has_metal = _detect_gpu()

        return HardwareInfo(
            os_name=platform.system(),
            os_version=platform.release(),
            cpu_name=cpu_name,
            cpu_cores=logical,
            cpu_physical=physical,
            ram_gb=ram_gb,
            gpu_name=gpu_name,
            vram_gb=vram_gb,
            has_cuda=has_cuda,
            has_metal=has_metal,
            platform_bits=platform.architecture()[0],
        )
    except Exception as e:
        log.error("Hardware detection failed: %s", e)
        return HardwareInfo(
            os_name=platform.system(),
            os_version=platform.release(),
            cpu_name="Unknown",
            cpu_cores=4,
            cpu_physical=4,
            ram_gb=8.0,
            gpu_name="Unknown",
            vram_gb=0.0,
            has_cuda=False,
            has_metal=False,
            platform_bits="64bit",
        )


# ── Recommendation Engine ──────────────────────────────────────────────

def recommend_models(
    hw: HardwareInfo,
    installed: list[str] | None = None
) -> HardwareProfile:
    """
    Given hardware, recommend the best 3 models:
    - Optimal: best quality that comfortably fits in RAM
    - Fast: best speed that comfortably fits in RAM
    - Quality: best quality (may require more RAM)
    """
    installed_set = set(installed or [])

    # Determine usable RAM: reserve ~2 GB OS overhead
    usable_ram = max(hw.ram_gb - 2.0, 0.5)

    # GPU-accelerated: VRAM matters most
    usable_vram = hw.vram_gb if (hw.has_cuda or hw.has_metal) else 0.0

    # Filter models that can fit
    def can_run(m: ModelSpec) -> bool:
        if hw.has_cuda and m.vram_gb > 0:
            return usable_vram >= m.vram_gb
        return usable_ram >= m.ram_gb

    runnable = [m for m in MODEL_CATALOG if can_run(m)]

    if not runnable:
        # Very limited RAM — suggest absolutely smallest
        runnable = [MODEL_CATALOG[0]]

    # Optimal: maximize quality among runnable
    optimal_model = max(runnable, key=lambda m: (m.quality_tier, m.speed_tier))

    # Fast: maximize speed among runnable
    fast_model = max(runnable, key=lambda m: (m.speed_tier, m.quality_tier))

    # Quality: allow models fitting with 1 GB margin less (may be slower)
    quality_candidates = [m for m in MODEL_CATALOG if m.ram_gb <= hw.ram_gb - 1.0]
    if not quality_candidates:
        quality_candidates = runnable
    quality_model = max(quality_candidates, key=lambda m: (m.quality_tier, -m.ram_gb))

    def make_rec(m: ModelSpec, tier: str) -> ModelRecommendation:
        return ModelRecommendation(
            name=m.name,
            reason=m.desc,
            tier=tier,
            quality_tier=m.quality_tier,
            speed_tier=m.speed_tier,
            ram_required=m.size_label,
            already_installed=m.name in installed_set,
        )

    recs = []
    seen: set[str] = set()
    for model, tier in [
        (optimal_model, "optimal"),
        (fast_model, "fast"),
        (quality_model, "quality"),
    ]:
        if model.name not in seen:
            recs.append(make_rec(model, tier))
            seen.add(model.name)

    # Warning
    warning = ""
    if hw.ram_gb < 4:
        warning = f"⚠️ Very low RAM ({hw.ram_gb} GB). Only tiny models supported. Performance will be limited."
    elif hw.ram_gb < 8:
        warning = f"RAM is {hw.ram_gb} GB. Small models recommended. Close other apps for best performance."

    # Summary
    accel = ""
    if hw.has_cuda:
        accel = f" · NVIDIA CUDA ({hw.vram_gb} GB VRAM)"
    elif hw.has_metal:
        accel = " · Apple Metal GPU"
    summary = (
        f"{hw.cpu_name} · {hw.cpu_cores} cores · {hw.ram_gb} GB RAM"
        f" · {hw.gpu_name}{accel}"
    )

    return HardwareProfile(
        hardware=hw,
        recommendations=recs,
        warning=warning,
        summary=summary,
    )


def profile_system(installed: list[str] | None = None) -> HardwareProfile:
    """Full pipeline: detect hardware → generate recommendations."""
    hw = detect_hardware()
    return recommend_models(hw, installed)
