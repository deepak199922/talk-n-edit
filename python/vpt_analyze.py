#!/usr/bin/env python3
"""Talk-n-Edit analysis sidecar.

Usage:  vpt_analyze.py <task> --in <file> --out <json> [--params '<json>']
Tasks:  transcribe | scenes | faces | doctor
Progress is printed to stdout as JSON lines: {"progress": 0.42, "stage": "..."}.
The result is written to --out as JSON. Exit code != 0 on failure (message on stderr).
"""
import argparse
import json
import os
import platform
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(os.path.dirname(HERE), "library", "models")


def emit(progress, stage):
    print(json.dumps({"progress": round(float(progress), 4), "stage": stage}), flush=True)


def is_apple_silicon():
    return sys.platform == "darwin" and platform.machine() == "arm64"


# ---------------------------------------------------------------- transcribe
MLX_MODELS = {
    "tiny": "mlx-community/whisper-tiny",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}


def load_wav16k(path):
    """Read a 16 kHz mono 16-bit WAV (written by the server) into float32 samples."""
    import wave

    import numpy as np  # type: ignore

    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16 kHz mono 16-bit WAV")
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(inp, params):
    audio = load_wav16k(inp) if inp.lower().endswith(".wav") else inp
    backend = params.get("backend", "auto")
    model = params.get("model", "large-v3-turbo")
    language = params.get("language") or None
    duration = float(params.get("duration") or 0)
    initial_prompt = params.get("prompt") or None
    if backend == "auto":
        backend = "mlx" if is_apple_silicon() else "faster-whisper"
    emit(0.02, f"loading {backend} {model}")
    words, segments, lang = [], [], language
    if backend == "mlx":
        import mlx_whisper  # type: ignore

        repo = MLX_MODELS.get(model, model)
        emit(0.05, "transcribing")
        # mlx-whisper reports no progress: estimate it from elapsed time (about 12x realtime on Apple Silicon).
        import threading

        done = threading.Event()
        t0 = time.time()
        expected = max(20.0, duration / 12.0)

        def heartbeat():
            while not done.wait(2.0):
                emit(0.05 + 0.9 * min(0.97, (time.time() - t0) / expected), "transcribing (estimated)")

        threading.Thread(target=heartbeat, daemon=True).start()
        try:
            res = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=repo,
                word_timestamps=True,
                language=language,
                initial_prompt=initial_prompt,
                condition_on_previous_text=False,
                hallucination_silence_threshold=2.0,
                verbose=None,
            )
        finally:
            done.set()
        lang = res.get("language", language)
        for s in res.get("segments", []):
            segments.append({"start": round(s["start"], 3), "end": round(s["end"], 3), "text": s["text"].strip()})
            for w in s.get("words", []) or []:
                words.append({"w": w["word"].strip(), "s": round(w["start"], 3), "e": round(w["end"], 3), "p": round(float(w.get("probability", 1)), 3)})
    else:
        from faster_whisper import WhisperModel  # type: ignore

        threads = int(params.get("threads") or os.cpu_count() or 2)
        m = WhisperModel(model, device="auto", compute_type="int8", cpu_threads=threads)
        emit(0.05, "transcribing")
        segs, info = m.transcribe(
            audio,
            language=language,
            word_timestamps=True,
            vad_filter=True,
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            hallucination_silence_threshold=2.0,
        )
        lang = info.language
        total = duration or info.duration or 1
        last = time.time()
        for s in segs:
            segments.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()})
            for w in s.words or []:
                words.append({"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3), "p": round(float(w.probability), 3)})
            if time.time() - last > 1:
                emit(0.05 + 0.93 * min(1, s.end / total), "transcribing")
                last = time.time()
    # Drop empty tokens and fix non-monotonic times.
    clean = []
    prev = 0.0
    for w in words:
        if not w["w"]:
            continue
        w["s"] = max(w["s"], prev)
        w["e"] = max(w["e"], w["s"] + 0.01)
        prev = w["s"]
        clean.append(w)
    emit(1, "done")
    return {"backend": backend, "model": model, "language": lang, "segments": segments, "words": clean}


# ---------------------------------------------------------------- scenes
def scenes(inp, params):
    from scenedetect import ContentDetector, SceneManager, open_video  # type: ignore

    emit(0.02, "detecting scenes")
    video = open_video(inp)
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=float(params.get("threshold", 27.0)), min_scene_len=int(params.get("minFrames", 12))))
    sm.detect_scenes(video=video, show_progress=False)
    out = [[round(a.get_seconds(), 3), round(b.get_seconds(), 3)] for a, b in sm.get_scene_list()]
    if not out:
        dur = float(params.get("duration") or 0)
        out = [[0.0, round(dur, 3)]]
    emit(1, "done")
    return {"scenes": out}


# ---------------------------------------------------------------- faces
def faces(inp, params):
    import cv2  # type: ignore

    sample_fps = float(params.get("sampleFps", 2))
    cap = cv2.VideoCapture(inp)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {inp}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    yunet_path = os.path.join(MODELS, "face_detection_yunet_2023mar.onnx")
    detector = None
    haar = None
    if os.path.exists(yunet_path):
        detector = cv2.FaceDetectorYN.create(yunet_path, "", (w, h), 0.6, 0.3, 50)
    else:
        haar = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
    step = max(1, int(round(fps / sample_fps)))
    frames = []
    i = 0
    last = time.time()
    emit(0.02, "finding faces")
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % step == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            t = i / fps
            found = []
            if detector is not None:
                _, dets = detector.detect(frame)
                if dets is not None:
                    for d in dets:
                        x, y, fw, fh = [float(v) for v in d[:4]]
                        found.append([round(x / w, 4), round(y / h, 4), round(fw / w, 4), round(fh / h, 4), round(float(d[14]), 3)])
            else:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                for (x, y, fw, fh) in haar.detectMultiScale(gray, 1.1, 5, minSize=(max(24, h // 20), max(24, h // 20))):
                    found.append([round(x / w, 4), round(y / h, 4), round(fw / w, 4), round(fh / h, 4), 0.8])
            frames.append({"t": round(t, 3), "faces": found})
            if time.time() - last > 1 and total:
                emit(0.02 + 0.97 * i / total, "finding faces")
                last = time.time()
        i += 1
    cap.release()
    emit(1, "done")
    return {"sampleFps": sample_fps, "width": w, "height": h, "detector": "yunet" if detector is not None else "haar", "frames": frames}



# ---------------------------------------------------------------- beats
def beats(inp, params):
    """Tempo + beat times with numpy only: spectral-flux onsets, autocorrelation tempo, DP beat tracking (Ellis 2007)."""
    import wave

    import numpy as np  # type: ignore

    emit(0.05, "reading audio")
    with wave.open(inp, "rb") as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            x = x.reshape(-1, w.getnchannels()).mean(axis=1)
    if len(x) < sr * 2:
        return {"tempo": 0, "beats": []}
    n_fft, hop = 2048, 512
    win = np.hanning(n_fft).astype(np.float32)
    frames = 1 + (len(x) - n_fft) // hop
    emit(0.2, "onsets")
    env = np.zeros(frames, dtype=np.float32)
    prev = None
    for i in range(0, frames, 2048):
        j = min(frames, i + 2048)
        idx = np.arange(i, j)[:, None] * hop + np.arange(n_fft)[None, :]
        spec = np.log1p(10 * np.abs(np.fft.rfft(x[idx] * win, axis=1)))
        if prev is not None:
            spec_full = np.vstack([prev[None, :], spec])
        else:
            spec_full = np.vstack([spec[:1], spec])
        env[i:j] = np.maximum(0, np.diff(spec_full, axis=0)).sum(axis=1)
        prev = spec[-1]
    env = env - np.convolve(env, np.ones(16) / 16, mode="same")
    env = np.maximum(env, 0)
    if env.std() > 0:
        env = env / env.std()
    fr = sr / hop
    emit(0.6, "tempo")
    ac = np.correlate(env, env, mode="full")[len(env) - 1 :]
    lags = np.arange(len(ac))
    bpm_of = lambda lag: 60.0 * fr / np.maximum(lag, 1)
    lo, hi = int(fr * 60 / 200), int(fr * 60 / 60)
    cand = lags[lo:hi]
    prior = np.exp(-0.5 * (np.log2(bpm_of(cand) / 120.0) / 0.9) ** 2)
    period = cand[np.argmax(ac[lo:hi] * prior)]
    tempo = float(bpm_of(period))
    emit(0.8, "beats")
    # Dynamic programming beat tracker.
    alpha = 100.0
    score = env.astype(np.float64).copy()
    back = np.full(len(env), -1)
    for t in range(len(env)):
        a, b = t - int(round(2 * period)), t - int(round(period / 2))
        if b <= 0:
            continue
        a = max(0, a)
        prevs = np.arange(a, b)
        pen = -alpha * np.log((t - prevs) / period) ** 2
        k = np.argmax(score[prevs] + pen)
        score[t] += score[prevs][k] + pen[k]
        back[t] = prevs[k]
    t = int(np.argmax(score[-int(period) :])) + len(score) - int(period)
    out = []
    while t >= 0:
        out.append(t)
        t = back[t]
    times = [round(float(i) / fr, 3) for i in reversed(out)]
    emit(1, "done")
    return {"tempo": round(tempo, 1), "beats": times}

# ---------------------------------------------------------------- doctor
def doctor(_inp, _params):
    info = {"python": sys.version.split()[0], "platform": f"{sys.platform}-{platform.machine()}"}
    for mod in ["cv2", "scenedetect", "mlx_whisper", "faster_whisper"]:
        try:
            __import__(mod)
            info[mod] = "ok"
        except Exception as e:  # noqa: BLE001
            info[mod] = f"missing ({type(e).__name__})"
    info["yunet"] = os.path.exists(os.path.join(MODELS, "face_detection_yunet_2023mar.onnx"))
    return info


TASKS = {"transcribe": transcribe, "scenes": scenes, "faces": faces, "beats": beats, "doctor": doctor}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("task", choices=sorted(TASKS))
    ap.add_argument("--in", dest="inp", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--params", default="{}")
    a = ap.parse_args()
    params = json.loads(a.params)
    try:
        res = TASKS[a.task](a.inp, params)
    except Exception as e:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(2)
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False)
    os.replace(tmp, a.out)


if __name__ == "__main__":
    main()
