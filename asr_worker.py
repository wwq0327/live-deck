#!/usr/bin/env python3
"""常驻的本地转写进程。

从 stdin 逐行读请求（JSON），往 stdout 逐行写结果。
模型只加载一次，之后每句都是纯推理。

两个后端：
  ASR_BACKEND=sensevoice（默认）— sherpa-onnx + SenseVoice int8，50–120ms/句
  ASR_BACKEND=whisper            — openai-whisper，0.6–0.9s/句

请求: {"id": 1, "wav": "/tmp/x.wav", "language": "zh", "prompt": "..."}
响应: {"id": 1, "text": "...", "ms": 812, "duration": 4.2}
就绪: {"ready": true, "model": "sensevoice-int8", "load_ms": 350}
"""
import json
import os
import re
import sys
import time
import warnings

warnings.filterwarnings("ignore")

BACKEND = os.environ.get("ASR_BACKEND", "sensevoice")
LANG = os.environ.get("ASR_LANG", "zh")
HERE = os.path.dirname(os.path.abspath(__file__))
SV_CANDIDATES = [
    os.path.join(HERE, "models", "sensevoice-onnx"),
    os.path.expanduser("~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx"),
    os.path.expanduser("~/.cache/sensevoice/sensevoice-onnx"),
]


def _find_sensevoice():
    env = os.environ.get("SENSEVOICE_DIR")
    if env:
        return os.path.expanduser(env)
    for d in SV_CANDIDATES:
        if os.path.exists(os.path.join(d, "model.int8.onnx")):
            return d
    return SV_CANDIDATES[0]  # 不存在时报错里带着它


SV_DIR = _find_sensevoice()

# whisper 用：这条 prompt 里不能用全角标点，否则输出里的逗号会变成 "Ｂ"
PROMPT = (
    "以下是普通话口播, 可能提到 AI, 大模型, DeepSeek, Harness, PPT, Agent, "
    "模型, 推理, 延迟, 字幕, 演讲, 幻灯片."
)

# 静音/极短片段上的幻觉
HALLUCINATIONS = [
    "谢谢观看", "谢谢大家", "请不吝点赞", "订阅", "转发", "打赏", "字幕由",
    "明镜与点点", "字幕志愿者", "感谢观看", "下期再见", "再见",
]

FIXUPS = [
    # 注意：中文也是 \w，所以不能用 \b —— 用前后不是字母来判断
    (re.compile(r"(?<![A-Za-z])T{2,3}(?![A-Za-z])"), "PPT"),   # SenseVoice 把 PPT 听成 TTT
    (re.compile(r"(?<![A-Za-z])P[.\,\s]*P[.\,\s]*T(?![A-Za-z])", re.I), "PPT"),
    (re.compile(r"(?<![A-Za-z])ppt(?![A-Za-z])", re.I), "PPT"),
    (re.compile(r"Deep\s*Seek", re.I), "DeepSeek"),
    (re.compile(r"DeepSeek\s*Har+ness", re.I), "DeepSeek Harness"),
    (re.compile(r"哈[内尼]斯|哈瑞斯|哈[内尼]丝"), "Harness"),
    (re.compile(r"[，,]\s*[，,]+"), "，"),
]


def cleanup(text, duration):
    t = (text or "").strip().replace("\uff22", "，").replace("　", " ")
    # 中文之间用全角逗号，去掉多余空格
    t = re.sub(r"(?<=[\u4e00-\u9fff])\s*,\s*", "，", t)
    t = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", t)
    for pat, rep in FIXUPS:
        t = pat.sub(rep, t)
    if duration and duration < 2.0:
        for h in HALLUCINATIONS:
            if t == h or (len(t) <= len(h) + 2 and h in t):
                return ""
    return t.strip(" ，,")


# ---------- SenseVoice ----------

def load_sensevoice():
    model = os.path.join(SV_DIR, "model.int8.onnx")
    if not os.path.exists(model):
        raise FileNotFoundError(
            f"找不到 SenseVoice 模型：{model}。"
            "把 model.int8.onnx + tokens.txt 放到 ./models/sensevoice-onnx/，"
            "或用 SENSEVOICE_DIR 指定目录；实在没有可先设 ASR_BACKEND=whisper。"
        )
    import sherpa_onnx

    rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=os.path.join(SV_DIR, "tokens.txt"),
        num_threads=int(os.environ.get("ASR_THREADS", "2")),
        use_itn=True,
        language=LANG,
        debug=False,
    )
    return rec


def transcribe_sensevoice(rec, path):
    import wave

    with wave.open(path) as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(n)
    if sr != 16000 or ch != 1 or sw != 2:
        raise ValueError(f"need 16k mono s16 wav, got {sr}Hz/{ch}ch/{sw * 8}bit")
    try:
        import numpy as np

        samples = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
    except ImportError:
        from array import array

        a = array("h")
        a.frombytes(raw)
        samples = [x / 32768.0 for x in a]

    s = rec.create_stream()
    s.accept_waveform(16000, samples)
    rec.decode_stream(s)
    return s.result.text, n / sr


# ---------- whisper ----------

def load_whisper():
    import whisper

    return whisper.load_model(os.environ.get("ASR_MODEL", "small"))


def transcribe_whisper(model, path, language, prompt):
    r = model.transcribe(
        path,
        language=language or "zh",
        fp16=False,
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=prompt or PROMPT,
        no_speech_threshold=0.6,
        logprob_threshold=-1.0,
    )
    return r.get("text"), float(r.get("duration") or 0)


def main():
    t0 = time.time()

    if BACKEND == "whisper":
        model = load_whisper()
        label = os.environ.get("ASR_MODEL", "small")
    else:
        try:
            model = load_sensevoice()
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"error": f"sensevoice load failed: {e}"}), flush=True)
            sys.exit(1)
        label = "sensevoice-int8"

    load_ms = int((time.time() - t0) * 1000)
    print(json.dumps({"ready": True, "model": label, "backend": BACKEND, "load_ms": load_ms}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"error": f"bad json: {e}"}), flush=True)
            continue

        rid = req.get("id")
        path = req.get("wav")
        try:
            t1 = time.time()
            if BACKEND == "whisper":
                text, dur = transcribe_whisper(model, path, req.get("language"), req.get("prompt"))
            else:
                text, dur = transcribe_sensevoice(model, path)
            text = cleanup(text, dur)
            print(
                json.dumps(
                    {"id": rid, "text": text, "ms": int((time.time() - t1) * 1000), "duration": round(dur, 2)},
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"id": rid, "error": str(e)}, ensure_ascii=False), flush=True)
        # 临时文件由 Node 父进程统一清理：重试/回退时父进程还要用同一份音频。


if __name__ == "__main__":
    main()
