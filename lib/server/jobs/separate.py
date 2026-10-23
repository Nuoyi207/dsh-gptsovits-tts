"""人声/伴奏分离：调用仓库自带的 uvr5 模型（不经过 gradio）。

用法：
    python -s jobs/separate.py --repo <仓库根> --in <文件或目录> --out <输出目录>
        [--model HP2_all_vocals] [--device cuda] [--format wav]

产物：<out>/vocals/*.wav（人声）、<out>/ins/*.wav（伴奏）。
"""
import argparse
import os
import subprocess
import sys
import traceback


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="HP2_all_vocals")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--half", type=int, default=1)
    ap.add_argument("--format", default="wav")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    os.chdir(repo)
    sys.path.insert(0, repo)
    sys.path.insert(0, os.path.join(repo, "tools"))
    sys.path.insert(0, os.path.join(repo, "tools", "uvr5"))

    weights = os.path.join(repo, "tools", "uvr5", "uvr5_weights")
    model_name = args.model
    is_hp3 = "HP3" in model_name
    vocal_root = os.path.join(args.out, "vocals")
    ins_root = os.path.join(args.out, "ins")
    tmp_root = os.path.join(args.out, "_reformat")
    for path in (vocal_root, ins_root, tmp_root):
        os.makedirs(path, exist_ok=True)

    if os.path.isdir(args.inp):
        inputs = [os.path.join(args.inp, name) for name in sorted(os.listdir(args.inp))]
        inputs = [p for p in inputs if os.path.isfile(p)]
    else:
        inputs = [args.inp]
    print("inputs:", len(inputs), flush=True)

    if "roformer" in model_name.lower():
        from bsroformer import Roformer_Loader  # type: ignore

        pre_fun = Roformer_Loader(
            model_path=os.path.join(weights, model_name + ".ckpt"),
            config_path=os.path.join(weights, model_name + ".yaml"),
            device=args.device,
            is_half=bool(args.half),
        )
    else:
        from vr import AudioPre, AudioPreDeEcho  # type: ignore

        func = AudioPreDeEcho if "DeEcho" in model_name else AudioPre
        pre_fun = func(
            agg=10,
            model_path=os.path.join(weights, model_name + ".pth"),
            device=args.device,
            is_half=bool(args.half),
        )
    print("model loaded:", model_name, flush=True)

    done = 0
    for index, inp_path in enumerate(inputs, start=1):
        try:
            base = os.path.splitext(os.path.basename(inp_path))[0]
            safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in base)[:60] or "clip"
            reformatted = os.path.join(tmp_root, "%s_%d.wav" % (safe, index))
            # uvr5 的 VR 模型要求 44.1kHz 双声道，统一先转一道，避免内部 reformat 分支
            proc = subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", inp_path, "-vn", "-acodec", "pcm_s16le", "-ac", "2", "-ar", "44100", reformatted,
                ],
                capture_output=True,
                text=True,
            )
            if proc.returncode != 0 or not os.path.isfile(reformatted):
                raise RuntimeError("ffmpeg 转换失败: %s" % (proc.stderr or "")[-300:])
            pre_fun._path_audio_(reformatted, ins_root, vocal_root, args.format, is_hp3)
            done += 1
            print("separated %d/%d %s" % (index, len(inputs), os.path.basename(inp_path)), flush=True)
        except Exception as exc:  # noqa: BLE001
            print("FAIL", os.path.basename(inp_path), type(exc).__name__, exc, flush=True)
            traceback.print_exc()

    try:
        del pre_fun
    except Exception:  # noqa: BLE001
        pass
    print("separated_total:", done, flush=True)
    return 0 if done else 2


if __name__ == "__main__":
    sys.exit(main())
