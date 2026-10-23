# -*- coding: utf-8 -*-
"""GPT-SoVITS V2ProPlus 常驻语音合成服务（DSH 插件后端）。

设计要点
- 常驻进程：模型只加载一次，参考音频特征（prompt / refer / sv_emb / phones1 / bert1）按音色缓存。
- 每个请求只做：文本前端 -> GPT 自回归 -> SoVITS 解码，避免官方 api_v2 每次重算参考特征。
- 仓库（沙箱只读），所以把仓库内的写操作重定向到 workdir\\shadow。
- 播放：winsound 在服务进程内直接出声（无需浏览器、无外部播放器）。
"""
from __future__ import annotations

import builtins
import gc
import io
import json
import os
import queue
import re
import sys

sys.dont_write_bytecode = True
import threading
import time
import traceback
import wave

BASE = os.path.dirname(os.path.abspath(__file__))
# 参考音频与音色配置属于用户数据：优先放 GSV_DATA_ROOT，跟着用户走、不随引擎重装丢失
REFS_DIR = os.path.join(os.environ.get("GSV_DATA_ROOT") or BASE, "refs")
AUDIO_EXT = (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".opus", ".wma")
WEIGHT_EXT = (".ckpt", ".pth", ".safetensors", ".pt")


# Windows 下不要弹出黑色控制台窗口：训练子进程（python/ffmpeg/taskkill）都用这套 flag
def _hidden_kwargs():
    if os.name != "nt":
        return {}
    info = subprocess.STARTUPINFO()
    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow = subprocess.SW_HIDE
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000), "startupinfo": info}


class _LineLog:
    """每次写都 open/append/close：不长期占用文件句柄，外部 tail 读得到。"""

    encoding = "utf-8"
    errors = "replace"

    def __init__(self, path):
        self.path = path

    def write(self, s):
        if not s:
            return 0
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, s.encode("utf-8", "replace"))
        finally:
            os.close(fd)
        return len(s)

    def flush(self):
        return None

    def isatty(self):
        return False


_LOG_PATH = os.environ.get("GSV_LOG")
if _LOG_PATH:
    sys.stdout = _LineLog(_LOG_PATH)
    sys.stderr = sys.stdout
print("[stage] process start", flush=True)
# 仓库根：优先 GSV_REPO；发布包里 server.py 位于 <engine>/app/，上一级就是仓库根。
_REPO_DEFAULT = os.environ.get("GSV_REPO") or ""
if not _REPO_DEFAULT:
    _parent = os.path.dirname(BASE)
    if os.path.isdir(os.path.join(_parent, "runtime")) and os.path.isdir(os.path.join(_parent, "GPT_SoVITS")):
        _REPO_DEFAULT = _parent
REPO = _REPO_DEFAULT
if not REPO or not os.path.isdir(REPO):
    raise SystemExit(
        "找不到语音引擎目录：请设置 GSV_REPO 环境变量指向已解压的引擎（应包含 runtime/ 与 GPT_SoVITS/），"
        "当前值：" + repr(REPO)
    )
VOICES_FILE = os.environ.get("GSV_VOICES") or os.path.join(
    os.environ.get("GSV_DATA_ROOT") or BASE, "voices.json"
)
VOICES_TEMPLATE = os.path.join(BASE, "voices.template.json")
if not os.path.isfile(VOICES_FILE) and os.path.isfile(VOICES_TEMPLATE):
    try:
        import shutil as _shutil

        _parent = os.path.dirname(VOICES_FILE)
        if _parent:
            os.makedirs(_parent, exist_ok=True)
        _shutil.copyfile(VOICES_TEMPLATE, VOICES_FILE)
    except Exception:
        pass
# 训练产物（素材、切片、数据集、权重）与仓库写重定向都放这里，不往引擎目录里写
DATA_ROOT = os.environ.get("GSV_DATA_ROOT") or os.path.join(BASE, "data")
SHADOW = os.path.join(DATA_ROOT, "shadow")
PORT = int(os.environ.get("GSV_PORT", "9866"))
PLAY_DIR = os.path.join(BASE, "audio")

_open_orig = builtins.open


def _open_redirect(file, mode="r", *args, **kwargs):
    """仓库内的写操作一律落到 shadow 目录。"""
    try:
        if isinstance(file, str) and any(ch in mode for ch in "wax+"):
            abspath = os.path.abspath(file)
            if abspath == REPO or abspath.startswith(REPO + os.sep):
                target = os.path.join(SHADOW, os.path.relpath(abspath, REPO))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                file = target
    except Exception:
        pass
    return _open_orig(file, mode, *args, **kwargs)


builtins.open = _open_redirect

os.makedirs(SHADOW, exist_ok=True)
os.makedirs(PLAY_DIR, exist_ok=True)
os.environ.setdefault("version", "v2ProPlus")
# librosa 的 @numba.guvectorize(cache=True) 会用 tempfile 在 TMP 里建缓存目录；
# 若 TMP 落在沙箱不可写的位置，import 会 100% CPU 死循环（实测）。
os.environ["TMP"] = os.path.join(SHADOW, "TEMP")
os.environ["TEMP"] = os.environ["TMP"]
os.environ["NUMBA_CACHE_DIR"] = os.path.join(BASE, "numba_cache")
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.makedirs(os.environ["TEMP"], exist_ok=True)
os.makedirs(os.environ["NUMBA_CACHE_DIR"], exist_ok=True)
os.chdir(REPO)
sys.path.insert(0, BASE)
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "GPT_SoVITS"))


def _stage(msg):
    print("[stage] %s t=%.1fs" % (msg, time.time() - _T0), flush=True)


_T0 = time.time()
import numpy as np  # noqa: E402

_stage("numpy")
import torch  # noqa: E402
import librosa  # noqa: E402

_stage("torch+librosa")
import soundfile as sf  # noqa: E402

_stage("soundfile")
# 固定输入尺寸的卷积在 Turing 上开 autotune 更稳
# cudnn.benchmark=True 在「句子长度每次都变」的场景下反而最慢：每遇到一个新形状
# 就要做一次算法计时搜索（实测 SovITS 解码 25ms → 590-650ms）。保持默认的启发式选择。
torch.backends.cudnn.benchmark = os.environ.get("GSV_CUDNN_BENCH", "0") == "1"
torch.backends.cuda.matmul.allow_tf32 = False
import inference_webui as iw  # noqa: E402

_stage("inference_webui: version=%s device=%s half=%s" % (iw.version, iw.device, iw.is_half))

try:
    import winsound
except ImportError:  # pragma: no cover
    winsound = None

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402
import uvicorn  # noqa: E402
import trainer as trainer_mod  # noqa: E402  一键训练编排（调仓库自带脚本，全部子进程）
from typing import List, Optional  # noqa: E402

# dict_language 的值（get_phones_and_bert 用） / dict_language 的键（change_sovits_weights 用）
LANGS = {"zh": "all_zh", "en": "en", "ja": "all_ja", "yue": "all_yue", "ko": "all_ko"}
LANGS_UI = {"zh": "中文", "en": "英文", "ja": "日文", "yue": "粤语", "ko": "韩文"}

LOCK = threading.RLock()
START_TS = time.time()
# 空闲多久没合成就把模型撤出显存（秒，0=不自动卸载）；可在面板里改，存进 voices.json
DEFAULT_IDLE_UNLOAD = int(os.environ.get("GSV_IDLE_UNLOAD", "600"))
# 插件心跳超时（秒）：DSH 后台被强杀时靠它兜底退出；0=不启用
HB_TIMEOUT = int(os.environ.get("GSV_HB_TIMEOUT", "30"))
STATE = {
    "ready": False,
    "loaded": False,
    "voice": None,
    "voices": {},
    "timing": {},
    "play_queue": 0,
    "error": None,
    "idle_unload_sec": DEFAULT_IDLE_UNLOAD,
    "last_activity": time.time(),
    "last_heartbeat": 0.0,
    "training": False,
}
VOICE_CACHE = {}

SPLIT_RE = re.compile(r"[^。！？!?；;\n]+[。！？!?；;]?")
# 首块加速：GPT 约 30ms/字，首句太长会拖慢第一声，所以在第一个逗号处再切一刀。
FIRST_SOFT_RE = re.compile(r"^(.{4,14}[，,、])")
FIRST_FAST_LIMIT = 10


def split_first_fast(pieces):
    if not pieces:
        return pieces
    head = pieces[0]
    if len(head) <= FIRST_FAST_LIMIT:
        return pieces
    m = FIRST_SOFT_RE.match(head)
    if not m:
        return pieces
    rest = head[m.end():].strip()
    tail = pieces[1:]
    return ([m.group(1)] + ([rest] if rest else []) + tail)


# 长句再切：一句 60+ 字要合成 1.7s，前一块放完可能还没备好，所以按逗号/顿号切到 ~26 字。
LONG_LIMIT = 26
LONG_SOFT_RE = re.compile(r"[^，,、：:；;]+[，,、：:；;]?")


def split_long(pieces, limit=LONG_LIMIT):
    """把过长的句子按标点切开（首块不动，首包还是要快）。"""
    if not pieces:
        return pieces
    out = []
    for idx, piece in enumerate(pieces):
        if idx == 0 or len(piece) <= limit:
            out.append(piece)
            continue
        buf = ""
        for raw in LONG_SOFT_RE.findall(piece):
            part = raw.strip()
            if not part:
                continue
            while len(part) > limit:
                if buf:
                    out.append(buf)
                    buf = ""
                out.append(part[:limit])
                part = part[limit:]
            if buf and len(buf) + len(part) > limit:
                out.append(buf)
                buf = part
            else:
                buf += part
        if buf:
            out.append(buf)
    return [p for p in out if p.strip()]

# 固定的一条工作线程：CUDA / cudnn.benchmark 的算子选择是按线程+形状缓存的，
# 每次请求另起线程会让第一个新形状重新 autotune（实测 SovITS 30ms → 650ms）。
WORKER = {"started": False, "busy": False}
JOB_Q = queue.Queue()


def _worker_loop():
    while True:
        fn = JOB_Q.get()
        WORKER["busy"] = True
        try:
            fn()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        finally:
            WORKER["busy"] = False
            JOB_Q.task_done()


def _ensure_worker():
    with LOCK:
        if WORKER["started"]:
            return
        threading.Thread(target=_worker_loop, daemon=True, name="gsv-worker").start()
        WORKER["started"] = True


def run_on_worker(fn, wait=False):
    """把合成/播报任务投给固定工作线程；wait=True 时阻塞到执行完。"""
    _ensure_worker()
    done = threading.Event()

    def wrapped():
        try:
            fn()
        finally:
            done.set()

    JOB_Q.put(wrapped)
    if wait:
        done.wait()


# --------------------------------------------------------------------------- 显存
# 这两个模型不随换音色重建（vq/t2s/sv 会被 change_* / init_sv_cn 重建），搬到 CPU 即可。
MODEL_ON_CPU = ("ssl_model", "bert_model")
UNLOAD_LOCK = threading.Lock()


def _touch():
    STATE["last_activity"] = time.time()


def _models_to_gpu():
    for name in MODEL_ON_CPU:
        model = getattr(iw, name, None)
        if model is None:
            continue
        try:
            model.to(iw.device)
        except Exception:  # noqa: BLE001
            traceback.print_exc()


def unload_models(reason="manual"):
    """把模型撤出显存，进程与端口保留；下次合成会自动重新加载（3-4s）。"""
    with UNLOAD_LOCK:
        if not STATE["loaded"]:
            return {"ok": True, "loaded": False, "freed": False, "reason": reason}
        t0 = time.perf_counter()
        stop_playback()
        if torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
            except Exception:  # noqa: BLE001
                pass
        for name in MODEL_ON_CPU:
            model = getattr(iw, name, None)
            if model is None:
                continue
            try:
                model.to("cpu")
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        # 这三个由 load_voice 里的 change_* / init_sv_cn 重建，直接丢掉释放显存
        iw.vq_model = None
        iw.t2s_model = None
        iw.sv_cn_model = None
        VOICE_CACHE.clear()
        STATE["voice"] = None
        STATE["ready"] = False
        STATE["loaded"] = False
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:  # noqa: BLE001
                pass
        ms = (time.perf_counter() - t0) * 1000.0
        print("[unload] reason=%s cost=%.0fms" % (reason, ms), flush=True)
        return {"ok": True, "loaded": False, "freed": True, "ms": round(ms, 1), "reason": reason}


def _guard_loop():
    """后台守卫：空闲卸载显存 + 心跳超时退出（DSH 后台被关掉时不留孤儿进程）。"""
    while True:
        time.sleep(5)
        try:
            hb = STATE.get("last_heartbeat") or 0.0
            if HB_TIMEOUT > 0 and hb and time.time() - hb > HB_TIMEOUT:
                print("[guard] no heartbeat for %.0fs, exit" % (time.time() - hb), flush=True)
                try:
                    if STATE.get("training"):
                        TRAINER.cancel()
                        print("[guard] 顺便取消了正在跑的训练", flush=True)
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
                os._exit(0)
            sec = STATE.get("idle_unload_sec") or 0
            if (
                sec > 0
                and STATE["loaded"]
                and not WORKER["busy"]
                and JOB_Q.empty()
                and PLAYBACK["state"] == "idle"
                and time.time() - STATE["last_activity"] > sec
            ):
                print("[guard] idle %.0fs > %ds, unload models" % (time.time() - STATE["last_activity"], sec), flush=True)
                unload_models("idle")
        except Exception:  # noqa: BLE001
            traceback.print_exc()


# --------------------------------------------------------------------------- 音色
def load_voices():
    with _open_orig(VOICES_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    STATE["voices"] = data["voices"]
    if "idle_unload_sec" in data:
        try:
            STATE["idle_unload_sec"] = max(0, int(data["idle_unload_sec"]))
        except (TypeError, ValueError):
            pass
    return data


def save_voices(data):
    """原子写回 voices.json（服务进程内直接改默认音色 / 增删音色）。"""
    tmp = VOICES_FILE + ".tmp"
    with _open_orig(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, VOICES_FILE)
    STATE["voices"] = data.get("voices", {})


def default_vid():
    try:
        return load_voices().get("default")
    except Exception:  # noqa: BLE001
        return None


def voice_cfg(vid):
    voices = STATE["voices"] or load_voices()["voices"]
    if vid not in voices:
        raise KeyError("unknown voice: %s" % vid)
    return voices[vid]


def build_ref_cache(vid, cfg):
    """把参考音频的全部特征算一次，之后每个请求复用。"""
    t0 = time.perf_counter()
    is_v2pro = iw.model_version in ("v2Pro", "v2ProPlus")
    ref_audio = cfg["ref_audio"]
    if ref_audio and not os.path.isabs(ref_audio):
        _cand = [os.path.join(BASE, ref_audio), os.path.join(REPO, ref_audio)]
        for _p in _cand:
            if os.path.isfile(_p):
                ref_audio = _p
                break
    prompt_text = (cfg.get("prompt_text") or "").strip()
    prompt_lang = LANGS.get(cfg.get("prompt_lang", "zh"), "all_zh")
    text_lang = LANGS.get(cfg.get("text_lang", "zh"), "all_zh")
    if prompt_text and prompt_text[-1] not in iw.splits:
        prompt_text += "。" if prompt_lang != "en" else "."
    with torch.inference_mode():
        wav16k, _ = librosa.load(ref_audio, sr=16000)
        if wav16k.shape[0] > 160000 or wav16k.shape[0] < 48000:
            raise ValueError("参考音频需在 3~10 秒之间: %.2fs" % (wav16k.shape[0] / 16000.0))
        wav16k = torch.from_numpy(wav16k)
        wav16k = wav16k.half().to(iw.device) if iw.is_half else wav16k.to(iw.device)
        zero = torch.zeros(
            int(iw.hps.data.sampling_rate * 0.3),
            dtype=torch.float16 if iw.is_half else torch.float32,
        ).to(iw.device)
        ssl_content = iw.ssl_model.model(torch.cat([wav16k, zero]).unsqueeze(0))["last_hidden_state"].transpose(1, 2)
        codes = iw.vq_model.extract_latent(ssl_content)
        prompt = codes[0, 0].unsqueeze(0).to(iw.device)
        if is_v2pro and iw.sv_cn_model is None:
            iw.init_sv_cn()
        refer, audio_tensor = iw.get_spepc(iw.hps, ref_audio, iw.dtype, iw.device, is_v2pro)
        sv_emb = iw.sv_cn_model.compute_embedding3(audio_tensor) if is_v2pro else None
        phones1, bert1, norm1 = iw.get_phones_and_bert(prompt_text, prompt_lang, iw.version)
    return {
        "vid": vid,
        "prompt": prompt,
        "refer": refer,
        "sv_emb": sv_emb,
        "phones1": phones1,
        "bert1": bert1,
        "prompt_text": prompt_text,
        "prompt_lang": prompt_lang,
        "text_lang": text_lang,
        "build_ms": (time.perf_counter() - t0) * 1000.0,
    }


def load_voice(vid):
    cfg = voice_cfg(vid)
    with LOCK:
        if STATE["voice"] == vid and vid in VOICE_CACHE:
            print("[voice] %s cache hit" % vid, flush=True)
            return VOICE_CACHE[vid]
        _models_to_gpu()
        t0 = time.perf_counter()
        ui_prompt = LANGS_UI.get(cfg.get("prompt_lang", "zh"), "中文")
        ui_text = LANGS_UI.get(cfg.get("text_lang", "zh"), "中文")
        # change_sovits_weights 是生成器：必须传语言参数（否则末尾 yield 引用未定义变量），且要遍历完
        for _ in iw.change_sovits_weights(
            os.path.join(REPO, cfg["sovits"]), prompt_language=ui_prompt, text_language=ui_text
        ):
            pass
        iw.change_gpt_weights(os.path.join(REPO, cfg["gpt"]))
        cache = build_ref_cache(vid, cfg)
        cache["version"] = "%s/%s" % (iw.version, iw.model_version)
        VOICE_CACHE[vid] = cache
        STATE["voice"] = vid
        STATE["loaded"] = True
        # 卸载过之后第一次合成走这里重载：重载成功就等于能合成，ready 要一起恢复
        # （否则 /health 会一直报 ready=false，面板/脚本会误判服务没就绪）
        STATE["ready"] = True
        _touch()
        cache["load_ms"] = (time.perf_counter() - t0) * 1000.0
        print(
            "[voice] %s loaded in %.0fms (cache %.0fms) version=%s/%s"
            % (vid, cache["load_ms"], cache["build_ms"], iw.version, iw.model_version),
            flush=True,
        )
        return cache


# --------------------------------------------------------------------------- 合成
def synth_pcm(text, cache, speed=1.0, top_k=20, top_p=0.6, temperature=0.6, text_lang=None):
    text = (text or "").strip()
    cfg = voice_cfg(cache["vid"])
    lang = LANGS.get(text_lang, cache["text_lang"]) if text_lang else cache["text_lang"]
    if text and text[-1] not in iw.splits:
        text += "。" if lang != "en" else "."
    _touch()
    t0 = time.perf_counter()
    phones2, bert2, norm2 = iw.get_phones_and_bert(text, lang, iw.version)
    t1 = time.perf_counter()
    with torch.inference_mode():
        bert = torch.cat([cache["bert1"], bert2], 1).to(iw.device).unsqueeze(0)
        ids = torch.LongTensor(cache["phones1"] + phones2).to(iw.device).unsqueeze(0)
        pred_semantic, idx = iw.t2s_model.model.infer_panel(
            ids,
            torch.tensor([ids.shape[-1]]).to(iw.device),
            cache["prompt"],
            bert,
            top_k=top_k,
            top_p=top_p,
            temperature=temperature,
            early_stop_num=iw.hz * iw.max_sec,
        )
        pred_semantic = pred_semantic[:, -idx:].unsqueeze(0)
        t2 = time.perf_counter()
        audio = iw.vq_model.decode(
            pred_semantic,
            torch.LongTensor(phones2).to(iw.device).unsqueeze(0),
            [cache["refer"]],
            speed=speed,
            sv_emb=[cache["sv_emb"]],
        )[0][0]
        t3 = time.perf_counter()
    pcm = audio.detach().cpu().float().numpy()
    peak = float(np.abs(pcm).max()) if pcm.size else 0.0
    if peak > 1.0:
        pcm = pcm / peak
    pcm16 = (pcm * 32767).astype(np.int16)
    sr = 32000 if iw.model_version in ("v1", "v2", "v2Pro", "v2ProPlus") else 24000
    timings = {
        "text_ms": (t1 - t0) * 1000.0,
        "gpt_ms": (t2 - t1) * 1000.0,
        "sovits_ms": (t3 - t2) * 1000.0,
        "total_ms": (t3 - t0) * 1000.0,
        "chars": len(text),
        "audio_ms": len(pcm16) / sr * 1000.0,
    }
    return pcm16, sr, timings, norm2


def to_wav_bytes(pcm16, sr):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


# --------------------------------------------------------------------------- 播放队列
PLAY_LOCK = threading.Lock()
SEQ = {"id": 0}
# 播报状态：idle / playing / paused。暂停用 winsound 的 SND_PURGE 打断当前句，
# 恢复时重播被打断的那一句（音频只有句级粒度，不做毫秒级 seek）。
PLAYBACK = {"seq": 0, "state": "idle", "index": 0, "chunks": 0, "voice": "", "text": "", "audio_ms": 0.0}
PAUSE_EVENT = threading.Event()
PAUSE_EVENT.set()


def _pb_start(seq, vid, text, chunks):
    PLAYBACK.update(
        {
            "seq": seq,
            "state": "playing",
            "index": 0,
            "chunks": chunks,
            "voice": vid,
            "text": text,
            "audio_ms": 0.0,
        }
    )
    PAUSE_EVENT.set()


def _pb_finish(seq):
    if PLAYBACK["seq"] == seq:
        PLAYBACK["state"] = "idle"
        PLAYBACK["index"] = PLAYBACK["chunks"]
    PAUSE_EVENT.set()


def _canceled(seq):
    return SEQ["id"] != seq or PLAYBACK["seq"] != seq


def _wait_if_paused(seq):
    while PLAYBACK["seq"] == seq and PLAYBACK["state"] == "paused" and SEQ["id"] == seq:
        PAUSE_EVENT.wait(0.15)


def _play_file(path):
    if winsound is None:
        return
    try:
        winsound.PlaySound(path, winsound.SND_FILENAME)
    except Exception:
        traceback.print_exc()


def _restore_default(after_vid=None):
    """试听别的音色之后，把默认音色换回热状态，别让自动朗读为下一次切换付代价。"""
    dvid = default_vid()
    if not dvid or dvid == after_vid or dvid == STATE["voice"]:
        return
    try:
        load_voice(dvid)
        print("[voice] restored default %s" % dvid, flush=True)
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def _drop_chunks(seq):
    """一段话播完（或被停止）后，删掉它自己的分块 wav，不留中间文件。"""
    prefix = "chunk_%d_" % seq
    try:
        for name in os.listdir(PLAY_DIR):
            if name.startswith(prefix):
                try:
                    os.remove(os.path.join(PLAY_DIR, name))
                except OSError:
                    pass
    except OSError:
        pass


def clean_audio_dir():
    """启动时清空上一次次留的分块（播放过的音频没有保留价值）。"""
    removed = 0
    try:
        for name in os.listdir(PLAY_DIR):
            if not name.startswith("chunk_"):
                continue
            try:
                os.remove(os.path.join(PLAY_DIR, name))
                removed += 1
            except OSError:
                pass
    except OSError:
        pass
    if removed:
        print("[boot] 清理残留分块 %d 个" % removed, flush=True)
    return removed


def clean_uploads(max_age_days=7):
    """浏览器上传的素材是临时中转：超过 max_age_days 天就删（训练目录里已有副本）。"""
    uploads = os.path.join(DATA_ROOT, "uploads")
    if not os.path.isdir(uploads):
        return 0
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    freed = 0
    for name in os.listdir(uploads):
        path = os.path.join(uploads, name)
        if not os.path.isfile(path):
            continue
        try:
            if os.path.getmtime(path) >= cutoff:
                continue
            freed += os.path.getsize(path)
            os.remove(path)
            removed += 1
        except OSError:
            pass
    if removed:
        print("[boot] 清理过期上传 %d 个（%.1f MB）" % (removed, freed / 1024.0 / 1024.0), flush=True)
    return removed


def speak_async(text, vid, speed=1.0, text_lang="zh", restore=False):
    _touch()
    """后台线程：逐句合成、逐句播放（合成与播放重叠，句间不等待）。"""
    with PLAY_LOCK:
        SEQ["id"] += 1
        seq = SEQ["id"]
    STATE["play_queue"] = seq
    # 新的一条朗读开始：立刻掐掉上一条的音频，并把旧 seq 标废，
    # 否则上一条会先把当前这句播完，听起来就是「点新的却接着播旧的」。
    PLAYBACK["seq"] = -1
    if winsound is not None:
        try:
            winsound.PlaySound(None, winsound.SND_PURGE)
        except Exception:
            pass

    def worker():
        cache = load_voice(vid)
        if SEQ["id"] != seq:
            return
        pieces = [p.strip() for p in SPLIT_RE.findall(text) if p.strip()]
        if not pieces:
            pieces = [text]
        pieces = split_first_fast(pieces)
        pieces = split_long(pieces)
        total = len(pieces)
        first_packet_ms = None
        started = time.perf_counter()
        audio_ms = 0.0
        _pb_start(seq, vid, text, total)
        # 合成线程先把后面几句准备好，播放线程只负责放 —— 句与句之间不再有「等合成」的空档
        ready = {}
        failure = {"error": None, "done": False}
        cond = threading.Condition()

        def produce():
            try:
                for j in range(total):
                    if _canceled(seq):
                        return
                    with LOCK:
                        pcm16, sr, timings, _ = synth_pcm(pieces[j], cache, speed=speed, text_lang=text_lang)
                    if _canceled(seq):
                        return
                    path = os.path.join(PLAY_DIR, "chunk_%d_%d.wav" % (seq, j))
                    sf.write(path, pcm16, sr, subtype="PCM_16")
                    with cond:
                        ready[j] = (path, timings)
                        cond.notify_all()
            except BaseException as exc:  # noqa: BLE001
                with cond:
                    failure["error"] = exc
                    cond.notify_all()
            finally:
                with cond:
                    failure["done"] = True
                    cond.notify_all()

        threading.Thread(target=produce, name="gsv-synth-%d" % seq, daemon=True).start()
        i = 0
        cur_path = None
        last_play_end = None
        try:
            while i < total:
                if cur_path is None:
                    with cond:
                        while i not in ready and not failure["done"]:
                            cond.wait(0.2)
                        if i in ready:
                            path, timings = ready.pop(i)
                        else:
                            error = failure["error"]
                            if error is not None:
                                raise error
                            print("[chunk] seq=%d i=%d 合成提前结束" % (seq, i), flush=True)
                            return
                    cur_path = path
                    audio_ms += timings["audio_ms"]
                    PLAYBACK["audio_ms"] = audio_ms
                    gap = ""
                    if last_play_end is not None:
                        gap = " gap=%.0fms" % ((time.perf_counter() - last_play_end) * 1000.0)
                    print(
                        "[chunk] seq=%d i=%d chars=%d text=%.1f gpt=%.1f sovits=%.1f total=%.1f audio=%.0fms%s"
                        % (
                            seq,
                            i,
                            timings["chars"],
                            timings["text_ms"],
                            timings["gpt_ms"],
                            timings["sovits_ms"],
                            timings["total_ms"],
                            timings["audio_ms"],
                            gap,
                        ),
                        flush=True,
                    )
                    if first_packet_ms is None:
                        first_packet_ms = (time.perf_counter() - started) * 1000.0
                        STATE["timing"] = {"seq": seq,
                            "voice": vid,
                            "first_packet_ms": first_packet_ms,
                            "chunks": total,
                            "last": timings,
                        }
                _wait_if_paused(seq)
                if _canceled(seq):
                    return
                PLAYBACK["index"] = i
                _play_file(cur_path)
                last_play_end = time.perf_counter()
                if PLAYBACK["state"] == "paused":
                    # 这一句被暂停打断：停在原地，恢复后重播本句
                    continue
                PLAYBACK["index"] = i + 1
                i += 1
                cur_path = None
        finally:
            _pb_finish(seq)
            _drop_chunks(seq)
        print(
            "[speak] seq=%d voice=%s chunks=%d first=%.0fms text=%s"
            % (seq, vid, len(pieces), first_packet_ms or -1, text[:24]),
            flush=True,
        )
        if restore:
            _restore_default(vid)

    run_on_worker(worker)
    return seq


def stop_playback():
    if winsound is not None:
        try:
            winsound.PlaySound(None, winsound.SND_PURGE)
        except Exception:
            pass
    with PLAY_LOCK:
        SEQ["id"] += 1  # 让正在跑的 worker 尽快返回
        STATE["play_queue"] = -1
    PLAYBACK["state"] = "idle"
    PLAYBACK["index"] = PLAYBACK["chunks"]
    PAUSE_EVENT.set()


def pause_playback():
    if PLAYBACK["state"] == "playing":
        PLAYBACK["state"] = "paused"
        PAUSE_EVENT.clear()
        if winsound is not None:
            try:
                winsound.PlaySound(None, winsound.SND_PURGE)
            except Exception:
                pass
    return PLAYBACK["state"]


def resume_playback():
    if PLAYBACK["state"] == "paused":
        PLAYBACK["state"] = "playing"
        PAUSE_EVENT.set()
    return PLAYBACK["state"]


# --------------------------------------------------------------------------- HTTP
app = FastAPI(title="gptsovits-tts")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- 一键训练
def _register_trained_voice(payload):
    """训练完把新音色写进 voices.json；不改默认音色，避免把用户正在用的那个顶掉。"""
    label = (payload.get("label") or "").strip() or "新音色"
    gpt = (payload.get("gpt") or "").strip()
    sovits = (payload.get("sovits") or "").strip()
    for path in (gpt, sovits):
        if not os.path.isfile(os.path.join(REPO, path)):
            raise RuntimeError("训练产出的权重不存在: %s" % path)
    data = load_voices()
    vid = _voice_id("", label, gpt, data["voices"])
    ref_path, dur = _prepare_ref(payload.get("ref_audio"), vid)
    data["voices"][vid] = {
        "label": label,
        "gpt": gpt,
        "sovits": sovits,
        "ref_audio": ref_path,
        "prompt_text": (payload.get("prompt_text") or "").strip(),
        "prompt_lang": payload.get("prompt_lang") or "zh",
        "text_lang": payload.get("text_lang") or "zh",
        "speed": 1.0,
        "trained": True,
    }
    if not data.get("default"):
        data["default"] = vid
    save_voices(data)
    STATE["voices"] = data["voices"]
    result = {}

    def job():
        try:
            cache = load_voice(vid)
            with LOCK:
                synth_pcm("你好呀。", cache)
            result["version"] = cache.get("version", "")
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            result["error"] = "%s: %s" % (type(exc).__name__, exc)

    run_on_worker(job, wait=True)
    if result.get("error"):
        raise RuntimeError("新音色加载失败: %s" % result["error"])
    return {
        "id": vid,
        "label": label,
        "ref_seconds": round(dur, 2),
        "version": result.get("version", ""),
    }


def _train_start():
    """训练前：停播 + 把合成模型撤出显存，让 GPU 全给训练用。"""
    stop_playback()
    STATE["training"] = True
    run_on_worker(lambda: unload_models("train"), wait=True)
    _free_vram_check()


def _free_vram_check():
    """训练前记录剩余显存；太少就明确报出来（8G 卡上训练约需 3G 以上）。"""
    try:
        import torch as _torch

        if not _torch.cuda.is_available():
            return
        free, total = _torch.cuda.mem_get_info()
        free_mb = int(free // (1024 * 1024))
        total_mb = int(total // (1024 * 1024))
        print("[train] 训练前显存：空闲 %d MB / 共 %d MB" % (free_mb, total_mb), flush=True)
        if free_mb < 3000:
            print(
                "[train] 警告：空闲显存不足 3000 MB，训练会极慢甚至失败；"
                "请先关闭占用显存的程序（任务管理器→性能→GPU 可看占用）",
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001
        print("[train] 显存检查失败：%s" % exc, flush=True)


def _train_finish():
    """训练后：把默认音色重新加载回显存，合成服务自动恢复。"""
    STATE["training"] = False
    vid = STATE["voice"] or default_vid()

    def job():
        if not vid:
            return
        try:
            cache = load_voice(vid)
            with LOCK:
                synth_pcm("你好呀。", cache)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    run_on_worker(job, wait=True)


def _vram_mb():
    """给训练器用的显存总量（MB）；查不到就返回 0 让训练器用默认值。"""
    try:
        import torch as _torch

        if _torch.cuda.is_available():
            return int(_torch.cuda.get_device_properties(0).total_memory // (1024 * 1024))
    except Exception:  # noqa: BLE001
        pass
    return 0


TRAINER = trainer_mod.Trainer(
    {
        "repo": REPO,
        "vram_mb": _vram_mb(),
        "python": os.environ.get("GSV_PYTHON") or os.path.join(REPO, "runtime", "python.exe"),
        "data_root": DATA_ROOT,
        "on_train_start": _train_start,
        "on_train_finish": _train_finish,
        "register_voice": _register_trained_voice,
    }
)


class SynthReq(BaseModel):
    text: str
    voice: str = ""
    speed: float = 1.0
    text_lang: str = "zh"
    top_k: int = 20
    top_p: float = 0.6
    temperature: float = 0.6


class SpeakReq(BaseModel):
    text: str
    voice: str = ""
    speed: float = 1.0
    text_lang: str = "zh"


def _voice(req_voice):
    """空 voice 一律走 voices.json 的 default（保证自动朗读永远是用户选的音色）。"""
    vid = (req_voice or "").strip()
    if not vid:
        vid = default_vid() or STATE["voice"] or ""
    voice_cfg(vid)
    return vid


@app.get("/health")
def health():
    return {
        "ok": True,
        "ready": STATE["ready"],
        "voice": STATE["voice"],
        "gpu": torch.cuda.is_available(),
        "voices": sorted(STATE["voices"].keys()),
        "timing": STATE["timing"],
        "error": STATE["error"],
    }


@app.get("/voices")
def voices():
    data = load_voices()
    default = data.get("default")
    items = []
    for key, cfg in data["voices"].items():
        cache = VOICE_CACHE.get(key) or {}
        items.append(
            {
                "id": key,
                "label": cfg.get("label", key),
                "gpt": cfg.get("gpt", ""),
                "sovits": cfg.get("sovits", ""),
                "ref_audio": cfg.get("ref_audio", ""),
                "prompt_text": cfg.get("prompt_text", ""),
                "cached": bool(cache),
                "version": cache.get("version", ""),
                "default": key == default,
                "active": key == STATE["voice"],
            }
        )
    items.sort(key=lambda x: (not x["default"], not x["active"], x["label"]))
    return {"default": default, "active": STATE["voice"], "ready": STATE["ready"], "voices": items}


@app.post("/synthesize")
def synthesize(req: SynthReq):
    t_req = time.perf_counter()
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    if STATE.get("training"):
        raise HTTPException(status_code=409, detail="正在训练音色，合成暂时停用")
    vid = _voice(req.voice)
    try:
        cache = load_voice(vid)
        t_load = time.perf_counter()
        with LOCK:
            pcm16, sr, timings, _ = synth_pcm(
                text,
                cache,
                speed=req.speed,
                top_k=req.top_k,
                top_p=req.top_p,
                temperature=req.temperature,
                text_lang=req.text_lang,
            )
        t_syn = time.perf_counter()
        data = to_wav_bytes(pcm16, sr)
        t_wav = time.perf_counter()
        print(
            "[synth] thread=%s chars=%d load=%.0f synth=%.0f wav=%.0f total=%.0f gpt=%.0f sovits=%.0f"
            % (
                threading.current_thread().name,
                len(text),
                (t_load - t_req) * 1000.0,
                (t_syn - t_load) * 1000.0,
                (t_wav - t_syn) * 1000.0,
                (t_wav - t_req) * 1000.0,
                timings["gpt_ms"],
                timings["sovits_ms"],
            ),
            flush=True,
        )
        return Response(
            content=data,
            media_type="audio/wav",
            headers={
                "x-synth-ms": "%.0f" % timings["total_ms"],
                "x-timing-json": json.dumps(timings, ensure_ascii=False),
                "cache-control": "no-store",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="%s: %s" % (type(exc).__name__, exc))


@app.post("/speak")
def speak(req: SpeakReq):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    if STATE.get("training"):
        raise HTTPException(status_code=409, detail="正在训练音色，合成暂时停用")
    vid = _voice(req.voice)
    seq = speak_async(text, vid, speed=req.speed, text_lang=req.text_lang)
    return {"ok": True, "seq": seq, "voice": vid, "chars": len(text)}


@app.post("/stop")
def stop():
    stop_playback()
    return {"ok": True, "state": PLAYBACK["state"]}


@app.post("/pause")
def pause():
    return {"ok": True, "state": pause_playback()}


@app.post("/resume")
def resume():
    return {"ok": True, "state": resume_playback()}


@app.get("/status")
def status():
    return dict(PLAYBACK, play_queue=STATE["play_queue"])


# --------------------------------------------------------------------------- 音色管理
class VoiceReq(BaseModel):
    id: str


class PreviewReq(BaseModel):
    voice: str
    text: str = ""


class AddVoiceReq(BaseModel):
    id: str = ""
    label: str = ""
    gpt: str = ""
    sovits: str = ""
    ref_audio: str = ""
    prompt_text: str = ""
    prompt_lang: str = "zh"
    text_lang: str = "zh"


class UpdateVoiceReq(BaseModel):
    id: str
    label: str = ""
    gpt: str = ""
    sovits: str = ""
    ref_audio: str = ""  # 空 = 不动参考音频
    prompt_text: str = ""
    prompt_lang: str = "zh"
    text_lang: str = "zh"


def _slug(text):
    return re.sub(r"[^0-9a-z]+", "-", (text or "").strip().lower()).strip("-")


def _safe_id(text):
    """音色 id：中文也保留（JSON 与 Windows 文件名都支持），只清掉路径分隔与非法字符。"""
    out = re.sub(r'[\\/:*?"<>|\s]+', "-", (text or "").strip()).strip("-.")
    return out[:40]


def _voice_id(requested, label, gpt, voices):
    """优先用调用方给的 id，其次音色名，再次权重文件名；全空才退回 voice。"""
    for candidate in (
        _safe_id(requested),
        _safe_id(label),
        _safe_id(os.path.splitext(os.path.basename(gpt or ""))[0]),
    ):
        if candidate:
            return _unique_id(candidate, voices)
    return _unique_id("voice", voices)


def _unique_id(base, voices):
    if base not in voices:
        return base
    i = 2
    while "%s-%d" % (base, i) in voices:
        i += 1
    return "%s-%d" % (base, i)


def _prepare_ref(src, vid):
    """校验参考音频（3~10 秒），转成单声道 PCM_16 存进 refs/，之后不再依赖原路径。"""
    src = os.path.abspath(os.path.expandvars((src or "").strip().strip('"')))
    if not os.path.isfile(src):
        raise ValueError("参考音频不存在: %s" % src)
    wav, sr = librosa.load(src, sr=None, mono=True)
    dur = float(len(wav)) / float(sr or 1)
    if dur < 3.0 or dur > 10.0:
        raise ValueError("参考音频需在 3~10 秒之间（这段 %.2f 秒）" % dur)
    os.makedirs(REFS_DIR, exist_ok=True)
    dst = os.path.join(REFS_DIR, vid + ".wav")
    sf.write(dst, wav, sr, subtype="PCM_16")
    return dst, dur


def _guard_training():
    """训练期间禁止把模型重新搬进显存：8G 卡上训练和合成抢显存，一抢就 OOM。"""
    if STATE.get("training"):
        raise HTTPException(status_code=409, detail="正在训练音色，暂时不能切换/试听（显存要留给训练）")


@app.post("/voice")
def set_voice(req: VoiceReq):
    _guard_training()
    data = load_voices()
    if req.id not in data["voices"]:
        raise HTTPException(status_code=404, detail="没有这个音色: %s" % req.id)
    data["default"] = req.id
    save_voices(data)
    result = {}

    def job():
        try:
            t0 = time.perf_counter()
            cache = load_voice(req.id)
            with LOCK:
                synth_pcm("你好呀。", cache)
            result.update(
                {
                    "load_ms": round(cache.get("load_ms", 0)),
                    "switch_ms": round((time.perf_counter() - t0) * 1000.0),
                    "version": cache.get("version", ""),
                }
            )
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            result["error"] = "%s: %s" % (type(exc).__name__, exc)

    run_on_worker(job, wait=True)
    if result.get("error"):
        raise HTTPException(status_code=500, detail="切换失败: %s" % result["error"])
    return {"ok": True, "default": req.id, **result}


@app.post("/preview")
def preview(req: PreviewReq):
    _guard_training()
    voice_cfg(req.voice)
    text = (req.text or "").strip() or "你好，我是刚换上的音色。"
    seq = speak_async(text, req.voice, restore=True)
    return {"ok": True, "seq": seq, "voice": req.voice}


@app.post("/voices/add")
def add_voice(req: AddVoiceReq):
    _guard_training()
    label = (req.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="音色名称不能为空")
    prompt_text = (req.prompt_text or "").strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="参考文本不能为空")
    gpt = (req.gpt or "").strip()
    sovits = (req.sovits or "").strip()
    if not gpt or not sovits:
        raise HTTPException(status_code=400, detail="请选择 GPT 与 SoVITS 权重")
    for rel in (gpt, sovits):
        if not os.path.isfile(os.path.join(REPO, rel)):
            raise HTTPException(status_code=400, detail="权重文件不存在: %s" % rel)
    data = load_voices()
    vid = _voice_id(req.id, label, gpt, data["voices"])
    try:
        ref_path, dur = _prepare_ref(req.ref_audio, vid)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))
    prev_default = data.get("default")
    data["voices"][vid] = {
        "label": label,
        "gpt": gpt,
        "sovits": sovits,
        "ref_audio": ref_path,
        "prompt_text": prompt_text,
        "prompt_lang": req.prompt_lang or "zh",
        "text_lang": req.text_lang or "zh",
        "speed": 1.0,
    }
    data["default"] = vid
    save_voices(data)
    result = {}

    def job():
        try:
            cache = load_voice(vid)
            with LOCK:
                synth_pcm("你好呀。", cache)
            result.update(
                {"version": cache.get("version", ""), "load_ms": round(cache.get("load_ms", 0))}
            )
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            result["error"] = "%s: %s" % (type(exc).__name__, exc)

    run_on_worker(job, wait=True)
    if result.get("error"):
        rollback = load_voices()
        rollback["voices"].pop(vid, None)
        if rollback.get("default") == vid:
            rollback["default"] = (
                prev_default if prev_default in rollback["voices"] else next(iter(rollback["voices"]))
            )
        save_voices(rollback)
        try:
            os.remove(os.path.join(REFS_DIR, vid + ".wav"))
        except OSError:
            pass
        raise HTTPException(status_code=400, detail="新音色加载失败: %s" % result["error"])
    return {"ok": True, "id": vid, "label": label, "ref_seconds": round(dur, 2), **result}


@app.post("/voices/update")
def update_voice(req: UpdateVoiceReq):
    """原地修改已有音色的配置：不用先删除再加回来（id 保持不变）。"""
    _guard_training()
    data = load_voices()
    if req.id not in data["voices"]:
        raise HTTPException(status_code=404, detail="没有这个音色: %s" % req.id)
    old = dict(data["voices"][req.id])
    label = (req.label or old.get("label") or req.id).strip()
    if not label:
        raise HTTPException(status_code=400, detail="音色名称不能为空")
    gpt = (req.gpt or old.get("gpt") or "").strip()
    sovits = (req.sovits or old.get("sovits") or "").strip()
    if not gpt or not sovits:
        raise HTTPException(status_code=400, detail="请选择 GPT 与 SoVITS 权重")
    for rel in (gpt, sovits):
        if not os.path.isfile(os.path.join(REPO, rel)):
            raise HTTPException(status_code=400, detail="权重文件不存在: %s" % rel)
    prompt_text = (req.prompt_text if (req.prompt_text or "").strip() else old.get("prompt_text", "")).strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="参考文本不能为空")

    entry = dict(old)
    entry.update(
        {
            "label": label,
            "gpt": gpt,
            "sovits": sovits,
            "prompt_text": prompt_text,
            "prompt_lang": req.prompt_lang or old.get("prompt_lang") or "zh",
            "text_lang": req.text_lang or old.get("text_lang") or "zh",
        }
    )
    dur = None
    new_ref = (req.ref_audio or "").strip()
    old_ref = (old.get("ref_audio") or "").strip()
    if new_ref and os.path.abspath(os.path.expandvars(new_ref)) != os.path.abspath(old_ref):
        try:
            ref_path, dur = _prepare_ref(new_ref, req.id)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc))
        entry["ref_audio"] = ref_path
    data["voices"][req.id] = entry
    save_voices(data)
    VOICE_CACHE.pop(req.id, None)  # 旧缓存（权重/参考特征）作废
    result = {}

    def job():
        try:
            cache = load_voice(req.id)
            with LOCK:
                synth_pcm("你好呀。", cache)
            result.update(
                {"version": cache.get("version", ""), "load_ms": round(cache.get("load_ms", 0))}
            )
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            result["error"] = "%s: %s" % (type(exc).__name__, exc)

    try:
        run_on_worker(job, wait=True)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        result.setdefault("error", "%s: %s" % (type(exc).__name__, exc))
    if result.get("error"):
        rollback = load_voices()
        rollback["voices"][req.id] = old
        save_voices(rollback)
        VOICE_CACHE.pop(req.id, None)
        try:
            run_on_worker(lambda: load_voice(req.id), wait=True)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        raise HTTPException(status_code=400, detail="保存失败（已回滚）: %s" % result["error"])
    # 改的不是默认音色时，把默认音色换回热状态，别让下一次自动朗读为切换付代价。
    run_on_worker(lambda: _restore_default(req.id), wait=False)
    out = {"ok": True, "id": req.id, "label": label, "updated": True, **result}
    if dur is not None:
        out["ref_seconds"] = round(dur, 2)
    return out


@app.post("/voices/remove")
def remove_voice(req: VoiceReq):
    data = load_voices()
    if req.id not in data["voices"]:
        raise HTTPException(status_code=404, detail="没有这个音色: %s" % req.id)
    if data.get("default") == req.id:
        raise HTTPException(status_code=400, detail="默认音色不能删除，请先切换到别的音色")
    if len(data["voices"]) <= 1:
        raise HTTPException(status_code=400, detail="至少要保留一个音色")
    del data["voices"][req.id]
    save_voices(data)
    VOICE_CACHE.pop(req.id, None)
    return {"ok": True, "removed": req.id, "default": data.get("default")}


@app.get("/weights")
def weights():
    """列出仓库里所有训练好的 GPT / SoVITS 权重，供侧边栏挑选。"""
    out = {"gpt": [], "sovits": []}
    try:
        names = sorted(os.listdir(REPO))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    for name in names:
        if name.startswith("GPT_weights"):
            key, ext = "gpt", ".ckpt"
        elif name.startswith("SoVITS_weights"):
            key, ext = "sovits", ".pth"
        else:
            continue
        for dirpath, _dirs, files in os.walk(os.path.join(REPO, name)):
            for fn in files:
                if not fn.lower().endswith(ext):
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                out[key].append(
                    {
                        "path": os.path.relpath(full, REPO).replace("\\", "/"),
                        "name": fn,
                        "dir": name,
                        "size_mb": round(st.st_size / 1048576.0, 1),
                        "mtime": int(st.st_mtime),
                    }
                )
    for key in out:
        out[key].sort(key=lambda x: (-x["mtime"], x["path"]))
    return out


@app.get("/browse")
def browse(path: str = "", kind: str = "audio"):
    """给侧边栏用的极简文件浏览：只列目录和音频文件。"""
    exts = WEIGHT_EXT if kind == "weights" else AUDIO_EXT
    target = (path or "").strip().strip('"')
    if not target:
        home = os.path.expanduser("~")
        target = os.path.join(home, "Desktop")
        if not os.path.isdir(target):
            target = home
    target = os.path.abspath(target)
    if os.path.isfile(target):
        target = os.path.dirname(target)
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail="目录不存在: %s" % target)
    dirs, files = [], []
    try:
        with os.scandir(target) as it:
            for entry in it:
                if entry.name.startswith("."):
                    continue
                try:
                    if entry.is_dir():
                        dirs.append(entry.name)
                    elif entry.name.lower().endswith(exts):
                        files.append(
                            {
                                "name": entry.name,
                                "full": entry.path,
                                "size_mb": round(entry.stat().st_size / 1048576.0, 1),
                            }
                        )
                except OSError:
                    continue
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    parent = os.path.dirname(target.rstrip("\\/"))
    return {
        "path": target,
        "parent": parent if parent and parent != target else "",
        "dirs": sorted(dirs, key=str.lower)[:300],
        "files": sorted(files, key=lambda x: x["name"].lower())[:300],
        "roots": [d + ":\\" for d in "CDEFG" if os.path.isdir(d + ":\\")],
    }


WARM_TEXTS = (
    "你好呀。",
    "现在开始预热声码器算子。",
    "这是一段稍微长一点的句子，用来让解码器提前熟悉这个形状。",
)


def _do_warmup(vid):
    started = time.perf_counter()
    cache = load_voice(vid)
    last = None
    for text in WARM_TEXTS:
        with LOCK:
            pcm16, sr, timings, _ = synth_pcm(text, cache)
        last = timings
        print(
            "[warmup] %d chars total=%.0fms gpt=%.0fms sovits=%.0fms"
            % (len(text), timings["total_ms"], timings["gpt_ms"], timings["sovits_ms"]),
            flush=True,
        )
    STATE["ready"] = True
    STATE["loaded"] = True
    _touch()
    STATE["timing"] = {
        "warmup": last,
        "load_ms": cache.get("load_ms"),
        "total_ms": (time.perf_counter() - started) * 1000.0,
    }
    return STATE["timing"]


@app.post("/warmup")
def warmup():
    vid = _voice("")
    result = {}
    run_on_worker(lambda: result.update(_do_warmup(vid)), wait=True)
    return result


@app.post("/reload")
def reload_voice(req: SynthReq):
    vid = _voice(req.voice)
    VOICE_CACHE.pop(vid, None)
    if STATE["voice"] == vid:
        STATE["voice"] = None
    cache = load_voice(vid)
    return {"ok": True, "voice": vid, "load_ms": cache.get("load_ms"), "build_ms": cache.get("build_ms")}


class BenchReq(BaseModel):
    text: str = "测试一下每句耗时。"
    n: int = 3
    bench: int = -1
    speed: float = 1.0


@app.post("/bench")
def bench(req: BenchReq):
    """同进程内对比 cudnn.benchmark 开/关对 SovITS 解码耗时的影响。"""
    if req.bench in (0, 1):
        torch.backends.cudnn.benchmark = bool(req.bench)
    vid = _voice("")
    cache = load_voice(vid)
    rows = []
    for _ in range(max(1, min(req.n, 10))):
        with LOCK:
            _, _, timings, _ = synth_pcm(req.text, cache, speed=req.speed)
        rows.append(
            {
                "chars": timings["chars"],
                "gpt_ms": round(timings["gpt_ms"], 1),
                "sovits_ms": round(timings["sovits_ms"], 1),
                "total_ms": round(timings["total_ms"], 1),
                "audio_ms": round(timings["audio_ms"]),
            }
        )
    return {"cudnn_benchmark": torch.backends.cudnn.benchmark, "rows": rows}


class ConfigReq(BaseModel):
    idle_unload_sec: int = -1


@app.get("/service")
def service():
    """面板用：进程/显存/空闲状态。

    显存给两组数：torch 张量占用（memory_allocated）只是模型权重，
    驱动实际占用还包含 CUDA context、cuDNN 工作区与缓存池，通常高 1-1.5G；
    面板展示用 vram_used_mb（由 mem_get_info 推算整卡已用，含其它程序）。
    """
    torch_mb = None
    reserved_mb = None
    vram_total_mb = None
    vram_free_mb = None
    if torch.cuda.is_available():
        try:
            torch_mb = round(torch.cuda.memory_allocated() / 1048576.0, 1)
            reserved_mb = round(torch.cuda.memory_reserved() / 1048576.0, 1)
            free_b, total_b = torch.cuda.mem_get_info()
            vram_free_mb = int(free_b // 1048576)
            vram_total_mb = int(total_b // 1048576)
        except Exception:  # noqa: BLE001
            pass
    play = dict(PLAYBACK)
    if play.get("text"):
        play["text"] = play["text"][:40] + ("…" if len(play["text"]) > 40 else "")
    return {
        "ok": True,
        "pid": os.getpid(),
        "loaded": STATE["loaded"],
        "ready": STATE["ready"],
        "voice": STATE["voice"],
        "idle_unload_sec": STATE["idle_unload_sec"],
        "idle_for": round(time.time() - STATE["last_activity"], 1) if STATE["loaded"] else 0,
        "uptime": round(time.time() - START_TS, 1),
        "torch_mb": torch_mb,
        "torch_reserved_mb": reserved_mb,
        "vram_total_mb": vram_total_mb,
        "vram_free_mb": vram_free_mb,
        "vram_used_mb": (vram_total_mb - vram_free_mb) if vram_total_mb else None,
        "playback": play,
    }


@app.post("/config")
def set_config(req: ConfigReq):
    if req.idle_unload_sec >= 0:
        sec = max(0, min(int(req.idle_unload_sec), 86400))
        # 先读盘再写盘：load_voices() 会用文件里的值覆盖 STATE，所以内存值必须最后落
        data = load_voices()
        data["idle_unload_sec"] = sec
        save_voices(data)
        STATE["idle_unload_sec"] = sec
        print("[config] idle_unload_sec=%d" % sec, flush=True)
    return {"ok": True, "idle_unload_sec": STATE["idle_unload_sec"]}


@app.post("/unload")
def unload():
    # 排到工作线程队列尾部，等正在进行的合成结束再卸
    run_on_worker(lambda: None, wait=True)
    return unload_models("api")


@app.post("/restart")
def restart():
    """软重启：停播 -> 卸载 -> 重新加载默认音色并预热（不动进程）。"""
    _guard_training()
    t0 = time.perf_counter()
    vid = _voice("")
    result = {}

    def job():
        stop_playback()
        unload_models("restart")
        STATE["voice"] = None
        result.update(_do_warmup(vid))
        STATE["voice"] = vid

    run_on_worker(job, wait=True)
    return {
        "ok": True,
        "voice": vid,
        "restart_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        "load_ms": result.get("load_ms"),
        "loaded": STATE["loaded"],
    }


@app.post("/shutdown")
def shutdown():
    """让进程自己退出（插件卸载/DSH 关闭时用）。正在训练就先取消，别留孤儿训练进程。"""
    def bye():
        time.sleep(0.4)
        try:
            if STATE.get("training"):
                TRAINER.cancel()
                print("[shutdown] 顺便取消了正在跑的训练", flush=True)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        print("[shutdown] exit by api", flush=True)
        os._exit(0)

    threading.Thread(target=bye, daemon=True, name="gsv-exit").start()
    return {"ok": True, "bye": True, "pid": os.getpid()}


@app.post("/heartbeat")
def heartbeat():
    STATE["last_heartbeat"] = time.time()
    return {"ok": True, "pid": os.getpid()}


# --------------------------------------------------------------------------- 素材时长估算
class DurationReq(BaseModel):
    paths: List[str] = []


def _ffprobe_path():
    local = os.path.join(REPO, "runtime", "ffprobe.exe")
    return local if os.path.isfile(local) else "ffprobe"


def _audio_seconds(path):
    """尽量便宜地拿一个文件的时长：wav/flac 走 soundfile 头信息，其余走 ffprobe。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".wav", ".flac", ".ogg", ".opus"):
        try:
            info = sf.info(path)
            if info.samplerate:
                return float(info.frames) / float(info.samplerate)
        except Exception:  # noqa: BLE001
            pass
    try:
        import subprocess

        done = subprocess.run(
            [_ffprobe_path(), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            capture_output=True,
            text=True,
            timeout=25,
            **_hidden_kwargs(),
        )
        return max(0.0, float((done.stdout or "").strip() or 0))
    except Exception:  # noqa: BLE001
        return 0.0


@app.post("/audio/duration")
def audio_duration(req: DurationReq):
    """估算选中素材的总时长（训练前提示用；切片后会略少）。"""
    total = 0.0
    counted = 0
    unknown = 0
    for raw in (req.paths or [])[:200]:
        path = (raw or "").strip()
        if not path:
            continue
        targets = []
        if os.path.isdir(path):
            try:
                for name in sorted(os.listdir(path)):
                    full = os.path.join(path, name)
                    if os.path.isfile(full) and os.path.splitext(name)[1].lower() in AUDIO_EXT:
                        targets.append(full)
            except OSError:
                targets = []
        elif os.path.isfile(path):
            targets = [path]
        for item in targets[:400]:
            seconds = _audio_seconds(item)
            if seconds > 0:
                total += seconds
                counted += 1
            else:
                unknown += 1
    return {"ok": True, "seconds": round(total, 1), "files": counted, "unknown": unknown}


# --------------------------------------------------------------------------- 一键训练接口
class TrainReq(BaseModel):
    name: str
    tier: str = "standard"
    files: List[str] = []
    separate: Optional[bool] = None
    epochs: int = 0  # 兼容老调用：同时覆盖两个阶段
    s2_epochs: int = 0  # SoVITS 轮数，0=用官方默认（8）
    s1_epochs: int = 0  # GPT 轮数，0=用官方默认（15）
    save_every_s2: int = 0
    save_every_s1: int = 0
    force: bool = False  # 素材不足也硬训（只保 20 秒硬底线）


@app.post("/upload")
async def upload(request: Request, name: str = "record.webm"):
    """接浏览器录音/上传的原始字节，落到 data/uploads 下，返回绝对路径。"""
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="空文件")
    folder = os.path.join(DATA_ROOT, "uploads")
    os.makedirs(folder, exist_ok=True)
    base = re.sub(r'[\\/:*?"<>|\s]+', "-", os.path.basename(name or "record"))[:60] or "record"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = os.path.join(folder, "%s-%s" % (stamp, base))
    with open(target, "wb") as handle:
        handle.write(payload)
    return {"ok": True, "path": target, "size": len(payload)}


@app.post("/train/start")
def train_start(req: TrainReq):
    try:
        job = TRAINER.start(
            req.name,
            tier=req.tier,
            inputs=req.files,
            separate=req.separate,
            epochs_override=req.epochs or None,
            s2_epochs=req.s2_epochs or None,
            s1_epochs=req.s1_epochs or None,
            save_every_s2=req.save_every_s2 or None,
            save_every_s1=req.save_every_s1 or None,
            force=bool(req.force),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "job": job}


@app.get("/train/status")
def train_status():
    return TRAINER.status()


@app.get("/train/log")
def train_log(offset: int = 0, limit: int = 200000):
    return TRAINER.tail(offset=offset, limit=limit)


@app.post("/train/cancel")
def train_cancel():
    return TRAINER.cancel()


def main():
    clean_audio_dir()
    clean_uploads()
    print("[boot] repo=%s" % REPO, flush=True)
    print("[boot] import done, cuda=%s half=%s" % (torch.cuda.is_available(), iw.is_half), flush=True)
    data = load_voices()
    vid = os.environ.get("GSV_VOICE") or data["default"]
    try:
        warmup_vid = _voice(vid)
        t0 = time.perf_counter()
        run_on_worker(lambda: _do_warmup(warmup_vid), wait=True)
        STATE["voice"] = warmup_vid
        print(
            "[boot] warmup voice=%s ready in %.0fms (load %.0fms)"
            % (warmup_vid, (time.perf_counter() - t0) * 1000.0, STATE["timing"].get("load_ms", -1)),
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        STATE["error"] = "%s: %s" % (type(exc).__name__, exc)
        traceback.print_exc()
    threading.Thread(target=_guard_loop, daemon=True, name="gsv-guard").start()
    print(
        "[boot] guard started idle_unload=%ds hb_timeout=%ds"
        % (STATE["idle_unload_sec"], HB_TIMEOUT),
        flush=True,
    )
    print("[boot] listening on http://127.0.0.1:%d" % PORT, flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
