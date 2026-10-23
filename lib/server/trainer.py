"""一键训练：素材 → 分离 → 切片 → 识别 → 数据集 → SoVITS → GPT → 注册音色。

不依赖 gradio/webui.py，按 webui.py 里的命令与环境变量在子进程里跑：
    GPT_SoVITS/prepare_datasets/1-get-text.py
    GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py
    GPT_SoVITS/prepare_datasets/2-get-sv.py          （版本名含 Pro 时）
    GPT_SoVITS/prepare_datasets/3-get-semantic.py
    GPT_SoVITS/s2_train.py --config <tmp>.json
    GPT_SoVITS/s1_train.py --config_file <tmp>.yaml

中间产物全部落在 <data_root>\\training\\<音色名>\\ 下，不进桌面仓库。
"""
import glob
import json
import os
import re
import shutil
import subprocess
import threading
import time
import traceback

import yaml

VERSION = "v2ProPlus"
AUDIO_EXT = (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".opus", ".wma")
MEDIA_EXT = (".mp4", ".mkv", ".mov", ".webm", ".avi", ".flv", ".ts")

TIERS = {
    "fast": {"label": "快速", "s2_epochs": 8, "s1_epochs": 8, "save_every": 4},
    "standard": {"label": "标准", "s2_epochs": 50, "s1_epochs": 15, "save_every": 5},
    "fine": {"label": "精细", "s2_epochs": 100, "s1_epochs": 25, "save_every": 10},
}
# 各档位要求的最少有效语音（秒）。官方建议 3 分钟以上，快速档放宽到 1 分钟
MIN_SECONDS = {"fast": 60, "standard": 120, "fine": 180}
# 官方 webui 1B-微调 的默认存盘间隔：SoVITS 每 4 轮、GPT 每 5 轮
SAVE_EVERY_S2 = 4
SAVE_EVERY_S1 = 5
# 官方 1B-微调 页的默认轮数：SoVITS 8 轮、GPT 15 轮（面板两个滑轨的初值）
DEFAULT_S2_EPOCHS = 8
DEFAULT_S1_EPOCHS = 15
BATCH_S2 = 4
BATCH_S1 = 4
LORA_RANK = "32"


# Windows 下不要弹出黑色控制台窗口：训练子进程（python/ffmpeg/taskkill）都用这套 flag
def _hidden_kwargs():
    if os.name != "nt":
        return {}
    info = subprocess.STARTUPINFO()
    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow = subprocess.SW_HIDE
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000), "startupinfo": info}


def _auto_batch(vram_mb, stage):
    """按显存挑 batch：8G 卡用小 batch 免得分页拖慢训练。"""
    override = os.environ.get("GSV_TRAIN_BATCH_%s" % stage.upper())
    if override:
        return max(1, int(override))
    if vram_mb and vram_mb < 9000:
        return 2
    if vram_mb and vram_mb < 12000:
        return 4
    return 6
REF_MIN, REF_MAX = 3.0, 10.0

STAGES = [
    ("collect", "整理素材", 0, 3),
    ("separate", "分离人声", 3, 12),
    ("slice", "切分音频", 12, 20),
    ("asr", "语音识别", 20, 32),
    ("dataset", "提取特征", 32, 48),
    ("train_s2", "训练音色模型（SoVITS）", 48, 80),
    ("train_s1", "训练韵律模型（GPT）", 80, 97),
    ("register", "注册音色", 97, 100),
]
STAGE_PERCENT = {key: (start, end) for key, _label, start, end in STAGES}
STAGE_LABEL = {key: label for key, label, _s, _e in STAGES}


def safe_name(text):
    text = (text or "").strip()
    text = re.sub(r'[\\/:*?"<>|\r\n\t]+', "-", text)
    text = re.sub(r"\s+", "-", text).strip("-.")
    return text[:40] or "voice"


def natural_key(name):
    return [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)]


class Trainer:
    """单实例训练编排；对外的 start/status/tail/cancel 都可被 HTTP 线程直接调用。"""

    def __init__(self, provider):
        self.P = provider
        self.lock = threading.RLock()
        self.thread = None
        self.proc = None
        self.cancel_flag = False
        self.log_path = ""
        self._epoch_total = {}
        self._bar = {}
        self._saw_epoch = {}
        self.state = {
            "running": False,
            "ok": None,
            "stage": "",
            "stage_label": "",
            "percent": 0,
            "message": "",
            "name": "",
            "tier": "",
            "started": 0.0,
            "finished": 0.0,
            "elapsed_ms": 0,
            "error": "",
            "result": None,
            "work_dir": "",
            "pipeline": [label for _k, label, _s, _e in STAGES],
        }

    # ------------------------------------------------------------------ 对外
    def status(self):
        with self.lock:
            data = dict(self.state)
        data["tiers"] = [
            {
                "key": key,
                "label": val["label"],
                "s2_epochs": val["s2_epochs"],
                "s1_epochs": val["s1_epochs"],
            }
            for key, val in TIERS.items()
        ]
        data["log_path"] = self.log_path
        return data

    def tail(self, offset=0, limit=200000):
        path = self.log_path
        if not path or not os.path.isfile(path):
            return {"text": "", "offset": 0, "size": 0}
        size = os.path.getsize(path)
        offset = max(0, min(int(offset or 0), size))
        with open(path, "rb") as handle:
            handle.seek(offset)
            chunk = handle.read(max(1024, min(int(limit or 200000), size - offset)))
        return {"text": chunk.decode("utf-8", "replace"), "offset": offset + len(chunk), "size": size}

    def cancel(self):
        with self.lock:
            if not self.state["running"]:
                return {"ok": False, "error": "当前没有训练任务"}
            self.cancel_flag = True
            self.state["message"] = "正在停止…"
            proc = self.proc
        if proc is not None:
            self._kill(proc)
        return {"ok": True}

    def start(
        self,
        name,
        tier="standard",
        inputs=None,
        separate=None,
        epochs_override=None,
        s2_epochs=None,
        s1_epochs=None,
        save_every_s2=None,
        save_every_s1=None,
        force=False,
    ):
        with self.lock:
            if self.state["running"]:
                raise RuntimeError("已有训练任务在跑，先等它结束或取消")
            if tier not in TIERS:
                raise RuntimeError("未知的训练档位：%s" % tier)
            s2_epochs = int(s2_epochs or epochs_override or DEFAULT_S2_EPOCHS)
            s1_epochs = int(s1_epochs or epochs_override or DEFAULT_S1_EPOCHS)
            if not 1 <= s2_epochs <= 400:
                raise RuntimeError("SoVITS 训练轮数要在 1~400 之间")
            if not 1 <= s1_epochs <= 400:
                raise RuntimeError("GPT 训练轮数要在 1~400 之间")
            # 官方 webui 默认：SoVITS 每 4 轮存一次、GPT 每 5 轮存一次
            save_every_s2 = max(1, min(int(save_every_s2 or SAVE_EVERY_S2), s2_epochs))
            save_every_s1 = max(1, min(int(save_every_s1 or SAVE_EVERY_S1), s1_epochs))
            # 先校验原始输入：safe_name 会给空名字兜底成 "voice"，那样用户空着名字也能训
            raw_name = (name or "").strip()
            if raw_name == "":
                raise RuntimeError("音色名称不能为空")
            name = safe_name(raw_name)
            if name == "":
                raise RuntimeError("音色名称里只有特殊字符，请改用中文/英文/数字")
            try:
                name.encode("gbk")
            except UnicodeEncodeError:
                raise RuntimeError("音色名称里有当前系统编码（GBK）不支持的字符，请改用中文/英文/数字")
            inputs = [os.path.abspath(p) for p in (inputs or []) if p and (os.path.isfile(p) or os.path.isdir(p))]
            if not inputs:
                raise RuntimeError("没有可用的素材文件")
            if separate is None:
                separate = any(p.lower().endswith(MEDIA_EXT) for p in inputs)
            work_dir = os.path.join(self.P["data_root"], "training", name)
            os.makedirs(work_dir, exist_ok=True)
            self.log_path = os.path.join(work_dir, "train.log")
            with open(self.log_path, "w", encoding="utf-8") as handle:
                handle.write("[train] name=%s tier=%s inputs=%d\n" % (name, tier, len(inputs)))
                for path in inputs:
                    handle.write("  - %s\n" % path)
            self.state.update(
                {
                    "running": True,
                    "ok": None,
                    "stage": "collect",
                    "stage_label": STAGE_LABEL["collect"],
                    "percent": 1,
                    "message": "准备素材",
                    "name": name,
                    "tier": tier,
                    "s2_epochs": s2_epochs,
                    "s1_epochs": s1_epochs,
                    "save_every_s2": save_every_s2,
                    "save_every_s1": save_every_s1,
                    "force": bool(force),
                    "audio_seconds": 0,
                    "started": time.time(),
                    "finished": 0.0,
                    "elapsed_ms": 0,
                    "error": "",
                    "result": None,
                    "work_dir": work_dir,
                }
            )
            self.cancel_flag = False
            self._epoch_total = {}
            self._bar = {}
            self._saw_epoch = {}
            job = {
                "name": name,
                "tier": tier,
                "inputs": inputs,
                "separate": bool(separate),
                "work_dir": work_dir,
                "epochs_override": epochs_override,
                "s2_epochs": s2_epochs,
                "s1_epochs": s1_epochs,
                "save_every_s2": save_every_s2,
                "save_every_s1": save_every_s1,
                "force": bool(force),
            }
        self.thread = threading.Thread(target=self._thread_main, args=(job,), name="gsv-train", daemon=True)
        self.thread.start()
        return self.status()

    # ------------------------------------------------------------------ 工具
    def _set(self, stage=None, message=None, percent=None, **extra):
        with self.lock:
            for key, value in extra.items():
                self.state[key] = value
            if stage:
                self.state["stage"] = stage
                self.state["stage_label"] = STAGE_LABEL.get(stage, stage)
                self.state["percent"] = max(self.state["percent"], STAGE_PERCENT.get(stage, (0, 100))[0] + 1)
            if message is not None:
                self.state["message"] = message
            if percent is not None:
                self.state["percent"] = max(self.state["percent"], max(0, min(100, int(percent))))

    def _write(self, text):
        try:
            with open(self.log_path, "a", encoding="utf-8", errors="replace") as handle:
                handle.write(text if text.endswith("\n") else text + "\n")
        except OSError:
            pass

    def _kill(self, proc):
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    **_hidden_kwargs(),
                )
            else:
                proc.kill()
        except Exception:  # noqa: BLE001
            pass

    def _env(self, extra=None):
        shadow = os.path.join(self.P["data_root"], "shadow", "TEMP")
        numba = os.path.join(self.P["data_root"], "numba_cache")
        for path in (shadow, numba):
            os.makedirs(path, exist_ok=True)
        env = os.environ.copy()
        env.update(
            {
                "TMP": shadow,
                "TEMP": shadow,
                "NUMBA_CACHE_DIR": numba,
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUNBUFFERED": "1",
                "PYTHONPATH": os.pathsep.join(
                    [self.P["repo"], os.path.join(self.P["repo"], "GPT_SoVITS")]
                ),
            }
        )
        if extra:
            env.update({key: str(val) for key, val in extra.items()})
        return env

    def _exec(self, args, stage, what, env_extra=None):
        if self.cancel_flag:
            raise RuntimeError("已取消")
        self._write("[cmd] " + " ".join(str(a) for a in args))
        proc = subprocess.Popen(
            [str(a) for a in args],
            cwd=self.P["repo"],
            env=self._env(env_extra),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            **_hidden_kwargs(),
        )
        with self.lock:
            self.proc = proc
        started = time.time()
        try:
            assert proc.stdout is not None
            reader = proc.stdout
            buf = b""
            while True:
                chunk = reader.read1(4096) if hasattr(reader, "read1") else reader.read(4096)
                if not chunk:
                    break
                buf += chunk
                parts = re.split(rb"[\r\n]+", buf)
                buf = parts.pop()
                for raw in parts:
                    line = raw.decode("utf-8", "replace").rstrip()
                    if not line:
                        continue
                    self._write(line)
                    self._parse_progress(stage, line)
                    if self.cancel_flag:
                        break
                if self.cancel_flag:
                    self._kill(proc)
                    break
            if buf.strip():
                line = buf.decode("utf-8", "replace").rstrip()
                self._write(line)
                self._parse_progress(stage, line)
            code = proc.wait()
        finally:
            with self.lock:
                self.proc = None
        cost = time.time() - started
        self._write("[%s] %s exit=%s cost=%.1fs" % (stage, what, code, cost))
        if self.cancel_flag:
            raise RuntimeError("已取消")
        if code != 0:
            raise RuntimeError("%s失败（exit=%s），详见训练日志" % (what, code))

    def _parse_progress(self, stage, line):
        start, end = STAGE_PERCENT.get(stage, (0, 100))
        total = self._epoch_total.get(stage) or 0
        match = re.search(r"train\.(\d+):\s*(\d+)%", line)
        if match and total:
            epoch = int(match.group(1))
            frac = int(match.group(2)) / 100.0
            ratio = min(1.0, (epoch - 1 + frac) / total)
            self._set(percent=start + (end - start) * ratio)
            return
        match = re.search(r"epoch\s*(\d+)\s*/\s*(\d+)", line, re.I)
        if match:
            epoch, span = int(match.group(1)), max(1, int(match.group(2)))
            self._set(percent=start + (end - start) * min(1.0, epoch / span))
        if stage in ("train_s2", "train_s1"):
            # 先认仓库脚本自己打的 "Train Epoch: 1 [37%]"，比 tqdm 的载入进度条准
            match = re.search(r"(?:Train )?Epoch:\s*(\d+)\s*\[(\d+)%\]", line)
            if match and total:
                epoch = int(match.group(1))
                frac = int(match.group(2)) / 100.0
                ratio = min(1.0, (epoch - 1 + frac) / total)
                self._saw_epoch[stage] = True
                self._bar[stage] = max(self._bar.get(stage, 0.0), ratio)
                self._set(percent=start + (end - start) * self._bar[stage])
                return
            if not self._saw_epoch.get(stage):
                return
            bars = re.findall(r"(\d+)/(\d+)\s*\[", line)
            if bars:
                done, span = int(bars[-1][0]), max(1, int(bars[-1][1]))
                ratio = min(1.0, done / float(span))
                prev = self._bar.get(stage, 0.0)
                if ratio > prev:
                    self._bar[stage] = ratio
                    self._set(percent=start + (end - start) * ratio)

    def _py(self):
        return self.P["python"]

    def _repo(self):
        return self.P["repo"]

    def _script(self, *parts):
        return os.path.join(self._repo(), *parts)

    def _local(self, *parts):
        """本目录（server.py / trainer.py / jobs/ 所在目录）里的配套脚本。"""
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), *parts)

    @staticmethod
    def _write_config(path, text):
        """仓库的 s2_train/s1_train 用默认编码读配置（中文 Windows 下是 GBK），这里照它的口味写。"""
        try:
            payload = text.encode("gbk")
        except UnicodeEncodeError:
            raise RuntimeError("训练配置里有 GBK 不支持的字符，请把音色名改成中文/英文/数字")
        with open(path, "wb") as handle:
            handle.write(payload)

    @staticmethod
    def _newest(paths):
        usable = [p for p in paths if os.path.isfile(p)]
        if not usable:
            return None
        return max(usable, key=os.path.getmtime)

    # ------------------------------------------------------------------ 主流程
    def _thread_main(self, job):
        started = time.time()
        try:
            self.P["on_train_start"]()
            result = self._pipeline(job)
            with self.lock:
                self.state.update(
                    {
                        "running": False,
                        "ok": True,
                        "percent": 100,
                        "message": "训练完成",
                        "finished": time.time(),
                        "elapsed_ms": int((time.time() - started) * 1000),
                        "result": result,
                    }
                )
            self._write("[done] %s" % json.dumps(result, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            self._write("[error] %s" % traceback.format_exc())
            cancelled = self.cancel_flag
            with self.lock:
                self.state.update(
                    {
                        "running": False,
                        "ok": False,
                        "message": "已取消" if cancelled else "训练失败",
                        "error": "" if cancelled else ("%s: %s" % (type(exc).__name__, exc)),
                        "finished": time.time(),
                        "elapsed_ms": int((time.time() - started) * 1000),
                    }
                )
        finally:
            # 任务一结束就把中间文件清掉：成功只留 weights/ 与 train.log，失败也只剩 train.log
            try:
                self._cleanup_workspace(job["work_dir"])
            except Exception:  # noqa: BLE001
                self._write("[warn] 清理中间文件失败：%s" % traceback.format_exc())
            try:
                self.P["on_train_finish"]()
            except Exception:  # noqa: BLE001
                self._write("[warn] 恢复合成服务失败：%s" % traceback.format_exc())
            with self.lock:
                self.proc = None

    def _pipeline(self, job):
        name, work_dir = job["name"], job["work_dir"]
        tier = TIERS[job["tier"]]
        s2_epochs = int(job.get("s2_epochs") or job["epochs_override"] or DEFAULT_S2_EPOCHS)
        s1_epochs = int(job.get("s1_epochs") or job["epochs_override"] or DEFAULT_S1_EPOCHS)
        # s2_train/s1_train 只在「轮数 % save_every == 0」时存权重，最后一轮不会额外保存
        # （实测 epochs=4/save_every=4 才会有 <名>_e4.pth）。把间隔压到不超过总轮数，
        # 保证无论轮数多小（冒烟测试用 1 轮）都一定产出权重。
        save_every_s2 = max(1, min(int(job.get("save_every_s2") or SAVE_EVERY_S2), s2_epochs))
        save_every_s1 = max(1, min(int(job.get("save_every_s1") or SAVE_EVERY_S1), s1_epochs))

        raw_dir = os.path.join(work_dir, "raw")
        sep_dir = os.path.join(work_dir, "separated")
        slice_dir = os.path.join(work_dir, "sliced")
        asr_dir = os.path.join(work_dir, "asr")
        ds_dir = os.path.join(work_dir, "dataset")
        weights_sovits = os.path.join(work_dir, "weights", "sovits")
        weights_gpt = os.path.join(work_dir, "weights", "gpt")
        for path in (raw_dir, sep_dir, slice_dir, asr_dir, ds_dir, weights_sovits, weights_gpt):
            os.makedirs(path, exist_ok=True)
        # s2_train 的 my_save() 直接 shutil.move 到 <exp_dir>/logs_s2_<版本>，
        # 不自己建目录（if_save_latest=1 必走这里），所以要提前建好，否则
        # FileNotFoundError: ... logs_s2_v2ProPlus/G_233333333333.pth
        for extra in ("logs_s2_%s" % VERSION, "logs_s1_%s" % VERSION):
            os.makedirs(os.path.join(ds_dir, extra), exist_ok=True)

        # 1) 收集素材：目录展开 + 拷进 raw/
        self._set("collect", "整理素材")
        sources = []
        for item in job["inputs"]:
            if os.path.isdir(item):
                for base, _dirs, files in os.walk(item):
                    for fname in files:
                        if fname.lower().endswith(AUDIO_EXT + MEDIA_EXT):
                            sources.append(os.path.join(base, fname))
            else:
                sources.append(item)
        if not sources:
            raise RuntimeError("素材目录里没有音频/视频文件")
        copied = 0
        for index, src in enumerate(sources):
            ext = os.path.splitext(src)[1].lower()
            if ext not in AUDIO_EXT and ext not in MEDIA_EXT:
                continue
            if ext == ".wav":
                dst = os.path.join(raw_dir, "%03d.wav" % index)
                if not os.path.isfile(dst):
                    shutil.copyfile(src, dst)
            else:
                # 手机录音（webm/m4a）、视频（mp4/mkv）统一转成 44.1k 单声道 wav，
                # 后面 uvr5 / slice_audio / ASR 都只认 wav，转换这一步省掉后患
                dst = os.path.join(raw_dir, "%03d.wav" % index)
                if not os.path.isfile(dst):
                    self._exec(
                        [
                            self._ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
                            "-i", src, "-vn", "-ac", "1", "-ar", "44100",
                            "-c:a", "pcm_s16le", dst,
                        ],
                        "collect",
                        "转码 %s" % os.path.basename(src),
                    )
            copied += 1
        if not copied:
            raise RuntimeError("没有可识别的音频/视频文件")
        self._set("collect", "素材 %d 个" % copied, 3)

        # 2) 分离人声（可选）
        vocals_dir = raw_dir
        if job["separate"]:
            self._set("separate", "分离人声（uvr5）")
            self._exec(
                [
                    self._py(), "-s", self._local("jobs", "separate.py"),
                    "--repo", self._repo(), "--in", raw_dir, "--out", sep_dir,
                    "--model", "HP2_all_vocals",
                ],
                "separate",
                "人声分离",
            )
            vocals_dir = os.path.join(sep_dir, "vocals")
            if not os.path.isdir(vocals_dir) or not os.listdir(vocals_dir):
                raise RuntimeError("人声分离没有产出文件")
            vocals_dir = self._flatten(vocals_dir, os.path.join(work_dir, "vocals"))
        self._set(percent=12)

        # 3) 切片
        self._set("slice", "切分音频（3~10 秒）")
        self._exec(
            [
                self._py(), "-s", self._script("tools", "slice_audio.py"),
                vocals_dir, slice_dir, "-34", "4000", "300", "10", "500", "0.9", "0.25", "0", "1",
            ],
            "slice",
            "音频切分",
        )
        clips = [p for p in glob_wavs(slice_dir) if p]
        if not clips:
            raise RuntimeError("切分后没有可用音频（可能是素材太短或静音太多）")
        self._write("[slice] clips=%d" % len(clips))
        self._set(percent=20)

        # 4) 语音识别
        self._set("asr", "语音识别（FunASR）")
        self._exec(
            [
                self._py(), "-s", self._script("tools", "asr", "funasr_asr.py"),
                "-i", slice_dir, "-o", asr_dir, "-s", "large", "-l", "zh", "-p", "float32",
            ],
            "asr",
            "语音识别",
        )
        entries = self._collect_asr(slice_dir, asr_dir, os.path.join(work_dir, "list.txt"))
        if not entries:
            raise RuntimeError("语音识别没有产出可用文本")
        total_sec = sum(item["seconds"] for item in entries)
        self._write("[asr] clips=%d total=%.1fs" % (len(entries), total_sec))
        # 官方建议 3 分钟以上；1 分钟也能出个能听的声音。轮数少（<=10）时放宽到 1 分钟，
        # 轮数多时必须给足素材，否则少量几句话会被学成复读机。
        min_sec = 60 if s2_epochs <= 10 else 120
        self._set(audio_seconds=round(total_sec, 1), audio_clips=len(entries))
        forced = bool(job.get("force"))
        if forced:
            # 用户明确点了「仍要训练」：只保留 20 秒的硬底线，避免真拿几秒钟去训
            if total_sec < 20:
                raise RuntimeError(
                    "有效语音只有 %.1f 秒（%d 段），连 20 秒的硬底线都不到，实在没法训练。"
                    "先用零样本吧：面板「新增音色」里点「用底模」。"
                    % (total_sec, len(entries))
                )
            self._write("[asr] force=true，有效语音 %.1fs 低于建议的 %ds，继续训练（效果会差）" % (total_sec, min_sec))
        elif total_sec < min_sec:
            raise RuntimeError(
                "有效语音只有 %.1f 秒（%d 段，切片+识别后剩下的），当前设置至少要 %d 秒，还差 %.0f 秒。"
                "素材太短可以先走零样本：面板「新增音色」里点「用底模」，"
                "只需 3~10 秒参考音频 + 一句参考文本就能直接说话，不用训练。"
                "确实想用这段素材硬训，可以点面板上的「仍要训练（效果会差）」。"
                % (
                    total_sec,
                    len(entries),
                    min_sec,
                    max(0.0, min_sec - total_sec),
                )
            )
        self._set(percent=32)

        # 5) 数据集：1-get-text / 2-get-hubert(+2-get-sv) / 3-get-semantic
        self._set("dataset", "提取特征（文本音素、HuBERT、语义 token）")
        base_env = {
            "inp_text": os.path.join(work_dir, "list.txt"),
            "inp_wav_dir": slice_dir,
            "exp_name": name,
            "opt_dir": ds_dir,
            "is_half": "True",
            "version": VERSION,
            "i_part": "0",
            "all_parts": "1",
            "_CUDA_VISIBLE_DEVICES": "0",
        }
        self._exec(
            [self._py(), "-s", self._script("GPT_SoVITS", "prepare_datasets", "1-get-text.py")],
            "dataset",
            "文本特征提取",
            dict(
                base_env,
                bert_pretrained_dir=self._script("GPT_SoVITS", "pretrained_models", "chinese-roberta-wwm-ext-large"),
            ),
        )
        self._set(percent=36)
        self._exec(
            [self._py(), "-s", self._script("GPT_SoVITS", "prepare_datasets", "2-get-hubert-wav32k.py")],
            "dataset",
            "HuBERT 特征提取",
            dict(
                base_env,
                cnhubert_base_dir=self._script("GPT_SoVITS", "pretrained_models", "chinese-hubert-base"),
                sv_path=self._script("GPT_SoVITS", "pretrained_models", "sv", "pretrained_eres2netv2w24s4ep4.ckpt"),
            ),
        )
        self._exec(
            [self._py(), "-s", self._script("GPT_SoVITS", "prepare_datasets", "2-get-sv.py")],
            "dataset",
            "SV 特征提取",
            dict(
                base_env,
                cnhubert_base_dir=self._script("GPT_SoVITS", "pretrained_models", "chinese-hubert-base"),
                sv_path=self._script("GPT_SoVITS", "pretrained_models", "sv", "pretrained_eres2netv2w24s4ep4.ckpt"),
            ),
        )
        self._set(percent=42)
        self._exec(
            [self._py(), "-s", self._script("GPT_SoVITS", "prepare_datasets", "3-get-semantic.py")],
            "dataset",
            "语义 token 提取",
            dict(
                base_env,
                pretrained_s2G=self._script("GPT_SoVITS", "pretrained_models", "v2Pro", "s2Gv2ProPlus.pth"),
                s2config_path=self._script("GPT_SoVITS", "configs", "s2v2ProPlus.json"),
            ),
        )
        # 单 part 时脚本会补 "-0" 后缀（2-name2text-0.txt / 6-name2semantic-0.tsv）
        semantic = self._newest(glob.glob(os.path.join(ds_dir, "6-name2semantic*.tsv")))
        phoneme = self._newest(glob.glob(os.path.join(ds_dir, "2-name2text*.txt")))
        if semantic is None:
            raise RuntimeError("缺少 6-name2semantic*.tsv，语义 token 提取失败")
        if phoneme is None:
            raise RuntimeError("缺少 2-name2text*.txt，文本特征提取失败")
        # s2_train.py 写死了读 <exp_dir>/2-name2text.txt（单 part 时脚本产出带 -0 后缀），补一份兼容名
        compat = os.path.join(ds_dir, "2-name2text.txt")
        if os.path.abspath(phoneme) != os.path.abspath(compat):
            shutil.copyfile(phoneme, compat)
        phoneme = compat
        self._set(percent=48)

        # 6) SoVITS（s2）
        self._set("train_s2", "训练音色模型（%d 轮）" % s2_epochs)
        self._epoch_total["train_s2"] = s2_epochs
        s2_config = self._write_s2_config(
            name, ds_dir, weights_sovits, s2_epochs, save_every_s2, work_dir
        )
        self._exec(
            [self._py(), "-s", self._script("GPT_SoVITS", "s2_train.py"), "--config", s2_config],
            "train_s2",
            "音色模型训练",
        )
        self._set(percent=80)

        # 7) GPT（s1）
        self._set("train_s1", "训练韵律模型（%d 轮）" % s1_epochs)
        self._epoch_total["train_s1"] = s1_epochs
        s1_config = self._write_s1_config(
            name, ds_dir, weights_gpt, s1_epochs, save_every_s1, work_dir, semantic, phoneme
        )
        self._exec(
            [self._py(), "-s", self._script("GPT_SoVITS", "s1_train.py"), "--config_file", s1_config],
            "train_s1",
            "韵律模型训练",
            {"hz": "25hz", "_CUDA_VISIBLE_DEVICES": "0"},
        )
        self._set(percent=97)

        # 8) 注册音色
        self._set("register", "注册音色")
        sovits_path = latest_weight(weights_sovits, ".pth")
        gpt_path = latest_weight(weights_gpt, ".ckpt")
        # 兜底：save_weight_dir 没生效时，从训练输出目录里捞最新的权重
        if not sovits_path:
            sovits_path = latest_weight(ds_dir, ".pth", recursive=True, prefix="G_")
        if not gpt_path:
            gpt_path = latest_weight(
                os.path.join(ds_dir, "logs_s1_%s" % VERSION), ".ckpt", recursive=True
            )
        if not sovits_path or not gpt_path:
            raise RuntimeError(
                "训练结束但没找到权重文件（sovits=%s, gpt=%s；检查 train.log 里的 save_weight_dir）"
                % (sovits_path, gpt_path)
            )
        ref_audio, prompt_text = self._pick_ref(entries, slice_dir, work_dir)
        info = self.P["register_voice"](
            {
                "label": name,
                "gpt": gpt_path,
                "sovits": sovits_path,
                "ref_audio": ref_audio,
                "prompt_text": prompt_text,
                "prompt_lang": "zh",
                "text_lang": "zh",
            }
        )
        # 训完把 s2/s1 的中间 checkpoint（每个几百 MB）清掉，只留导出的权重
        self._prune_intermediate(ds_dir)
        return {
            "name": name,
            "voice_id": info.get("id"),
            "gpt": gpt_path,
            "sovits": sovits_path,
            "ref_audio": ref_audio,
            "seconds": round(total_sec, 1),
            "clips": len(entries),
            "s2_epochs": s2_epochs,
            "s1_epochs": s1_epochs,
        }

    # ------------------------------------------------------------------ 子步骤
    def _cleanup_workspace(self, work_dir):
        """训练任务结束后清掉所有中间产物（原素材副本、分离/切片/特征/日志目录、临时配置）。

        保留：weights/（注册音色要用的权重）与 train.log（几百 KB，便于回溯失败原因）。
        """
        if not work_dir or not os.path.isdir(work_dir):
            return 0
        keep_files = {"train.log"}
        keep_dirs = {"weights"}
        freed = 0
        removed = 0
        for name in os.listdir(work_dir):
            path = os.path.join(work_dir, name)
            if os.path.isdir(path):
                if name in keep_dirs:
                    continue
                freed += self._dir_size(path)
                shutil.rmtree(path, ignore_errors=True)
            else:
                if name in keep_files:
                    continue
                try:
                    freed += os.path.getsize(path)
                    os.remove(path)
                except OSError:
                    pass
            removed += 1
        self._write("[clean] 任务结束清理 %d 项，释放 %.1f MB" % (removed, freed / 1024.0 / 1024.0))
        return freed

    @staticmethod
    def _dir_size(path):
        total = 0
        for root, _dirs, files in os.walk(path):
            for item in files:
                try:
                    total += os.path.getsize(os.path.join(root, item))
                except OSError:
                    pass
        return total

    def _prune_intermediate(self, ds_dir):
        """删掉 s2/s1 的 logs_* 中间 checkpoint（每个几百 MB），导出的权重不受影响。"""
        removed = 0
        for name in os.listdir(ds_dir):
            if not name.startswith(("logs_s2_", "logs_s1_")):
                continue
            target = os.path.join(ds_dir, name)
            for root, _dirs, files in os.walk(target):
                for item in files:
                    if item.lower().endswith((".pth", ".ckpt")):
                        try:
                            os.remove(os.path.join(root, item))
                            removed += 1
                        except OSError:
                            pass
        if removed:
            self._write("[prune] 清理中间 checkpoint %d 个" % removed)

    def _flatten(self, src_dir, dst_dir):
        os.makedirs(dst_dir, exist_ok=True)
        files = [p for p in glob_wavs(src_dir)]
        for index, path in enumerate(sorted(files, key=natural_key)):
            shutil.copyfile(path, os.path.join(dst_dir, "%03d.wav" % index))
        return dst_dir

    def _collect_asr(self, slice_dir, asr_dir, out_path):
        lists = sorted(glob.glob(os.path.join(asr_dir, "*.list")), key=os.path.getmtime)
        if not lists:
            lists = sorted(glob.glob(os.path.join(asr_dir, "*.list")), key=os.path.getmtime)
        if not lists:
            raise RuntimeError("语音识别没有生成 .list 文件")
        entries = []
        for list_path in lists:
            with open(list_path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    parts = line.rstrip("\n").split("|")
                    if len(parts) < 4:
                        continue
                    path, _name, lang, text = parts[0], parts[1], parts[2], "|".join(parts[3:])
                    if not os.path.isabs(path):
                        candidate = os.path.join(slice_dir, os.path.basename(path))
                        path = candidate if os.path.exists(candidate) else path
                    if not os.path.isfile(path):
                        continue
                    text = (text or "").strip()
                    if len(text) < 2:
                        continue
                    if lang.upper() not in ("ZH", "EN", "JA", "ZH-EN"):
                        continue
                    entries.append({"path": path, "text": text, "seconds": wav_seconds(path)})
        if not entries:
            raise RuntimeError("语音识别的文本为空")
        with open(out_path, "w", encoding="utf-8") as handle:
            for item in entries:
                handle.write("%s|%s|ZH|%s\n" % (item["path"], os.path.splitext(os.path.basename(item["path"]))[0], item["text"]))
        return entries

    def _ffmpeg(self):
        """优先用整合包自带的 ffmpeg.exe（runtime 里那一个），没有才退回 PATH 里的。"""
        bundled = os.path.join(self._repo(), "runtime", "ffmpeg.exe")
        return bundled if os.path.isfile(bundled) else "ffmpeg"

    def _pick_ref(self, entries, slice_dir, work_dir):
        best = None
        for item in entries:
            seconds = item["seconds"]
            if REF_MIN <= seconds <= REF_MAX:
                if best is None or abs(seconds - 6.0) < abs(best["seconds"] - 6.0):
                    best = item
        if best is not None:
            return best["path"], best["text"]
        # 没有 3~10 秒的整句：从最长的人声里截 8 秒
        clips = [p for p in glob_wavs(slice_dir) if p]
        if not clips:
            raise RuntimeError("没有可用参考音频")
        longest = max(clips, key=os.path.getsize)
        trimmed = os.path.join(work_dir, "ref_trim.wav")
        subprocess.run(
            [self._ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", longest, "-t", "8", "-ac", "1", trimmed],
            check=False,
            **_hidden_kwargs(),
        )
        if not os.path.isfile(trimmed):
            raise RuntimeError("参考音频裁剪失败")
        return trimmed, entries[0]["text"]

    def _write_s2_config(self, name, ds_dir, weights_dir, epochs, save_every, work_dir):
        template = self._script("GPT_SoVITS", "configs", "s2v2ProPlus.json")
        with open(template, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        vram = int(self.P.get("vram_mb") or 0)
        data["train"]["batch_size"] = BATCH_S2 if vram >= 12000 else _auto_batch(vram, "s2")
        data["train"]["epochs"] = epochs
        data["train"]["text_low_lr_rate"] = 0.4
        data["train"]["pretrained_s2G"] = self._script(
            "GPT_SoVITS", "pretrained_models", "v2Pro", "s2Gv2ProPlus.pth"
        )
        data["train"]["pretrained_s2D"] = self._script(
            "GPT_SoVITS", "pretrained_models", "v2Pro", "s2Dv2ProPlus.pth"
        )
        data["train"]["if_save_latest"] = True
        data["train"]["if_save_every_weights"] = True
        data["train"]["save_every_epoch"] = save_every
        data["train"]["gpu_numbers"] = "0"
        data["train"]["grad_ckpt"] = bool(vram and vram < 10000)
        data["train"]["lora_rank"] = LORA_RANK
        data["model"]["version"] = VERSION
        data["data"]["exp_dir"] = ds_dir
        data["s2_ckpt_dir"] = ds_dir
        data["save_weight_dir"] = weights_dir
        data["name"] = name
        data["version"] = VERSION
        target = os.path.join(work_dir, "tmp_s2.json")
        # 仓库脚本用默认编码（中文 Windows 下是 GBK）读配置，这里必须照它的口味写
        self._write_config(target, json.dumps(data, ensure_ascii=False, indent=2))
        return target

    def _write_s1_config(self, name, ds_dir, weights_dir, epochs, save_every, work_dir, semantic, phoneme):
        template = self._script("GPT_SoVITS", "configs", "s1longer-v2.yaml")
        with open(template, "r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
        vram = int(self.P.get("vram_mb") or 0)
        data.setdefault("train", {})
        data["train"]["batch_size"] = BATCH_S1 if vram >= 12000 else _auto_batch(vram, "s1")
        data["train"]["epochs"] = epochs
        data["train"]["save_every_n_epoch"] = save_every
        data["train"]["if_save_every_weights"] = True
        data["train"]["if_save_latest"] = True
        data["train"]["if_dpo"] = False
        data["train"]["half_weights_save_dir"] = weights_dir
        data["train"]["exp_name"] = name
        data["pretrained_s1"] = self._script("GPT_SoVITS", "pretrained_models", "s1v3.ckpt")
        data["train_semantic_path"] = semantic
        data["train_phoneme_path"] = phoneme
        data["output_dir"] = os.path.join(ds_dir, "logs_s1_%s" % VERSION)
        target = os.path.join(work_dir, "tmp_s1.yaml")
        self._write_config(target, yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
        return target


def glob_wavs(folder):
    if not os.path.isdir(folder):
        return []
    return [
        os.path.join(folder, name)
        for name in sorted(os.listdir(folder), key=natural_key)
        if os.path.isfile(os.path.join(folder, name)) and name.lower().endswith(".wav")
    ]


def latest_weight(folder, ext, recursive=False, prefix=""):
    """返回 folder（或递归其子目录）里最新的、指定扩展名（可加文件名前缀）的权重。"""
    if not os.path.isdir(folder):
        return ""
    files = []
    if recursive:
        for root, _dirs, names in os.walk(folder):
            for item in names:
                if item.lower().endswith(ext) and item.startswith(prefix):
                    files.append(os.path.join(root, item))
    else:
        files = [os.path.join(folder, n) for n in os.listdir(folder) if n.lower().endswith(ext)]
    if not files:
        return ""
    return max(files, key=os.path.getmtime)


def wav_seconds(path):
    """不依赖 librosa，直接读 wav 头算时长（ASR 切片都是 PCM wav）。"""
    try:
        import wave

        with wave.open(path, "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate() or 1
        return frames / float(rate)
    except Exception:  # noqa: BLE001
        try:
            import soundfile

            info = soundfile.info(path)
            return float(info.frames) / float(info.samplerate or 1)
        except Exception:  # noqa: BLE001
            return 0.0
