import argparse
import json
import os
import sys
import threading
import traceback


def send(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def pick_device(prefer):
    """Return a usable torch device, falling back to CPU when CUDA fails."""
    if str(prefer).strip().lower() != "cuda":
        return "cpu"
    try:
        import torch

        if not torch.cuda.is_available():
            return "cpu"
        torch.zeros(1, device="cuda")
        return "cuda"
    except Exception:
        print(
            f"CUDA 不可用，回退 CPU：{traceback.format_exc()}",
            file=sys.stderr,
            flush=True,
        )
        return "cpu"


def resolve_device(kind):
    if kind == "llm":
        env_key = "ARKPET_LOCAL_LLM_DEVICE"
        default = "cuda"
    else:
        env_key = "ARKPET_LOCAL_ASR_DEVICE"
        default = "cpu"
    return pick_device(os.environ.get(env_key) or default)


def load_llm(source_path, model_id, device="cpu"):
    import torch
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    if source_path.lower().endswith(".gguf"):
        try:
            from llama_cpp import Llama
        except Exception as error:
            try:
                from ctransformers import LLM as CTransformersLLM
            except Exception as fallback_error:
                raise RuntimeError(
                    "GGUF 运行组件尚未安装，需要 llama-cpp-python 或 ctransformers。"
                ) from fallback_error
            model = CTransformersLLM(
                model_path=source_path,
                context_length=4096,
                threads=max(2, (os.cpu_count() or 4) - 1),
                gpu_layers=0,
            )
            return {
                "backend": "ctransformers",
                "model": model,
                "tokenizer": None,
            }
        model = Llama(
            model_path=source_path,
            n_ctx=4096,
            n_threads=max(2, (os.cpu_count() or 4) - 1),
            verbose=False,
        )
        return {
            "backend": "llama.cpp",
            "model": model,
            "tokenizer": None,
        }

    if os.path.isdir(source_path):
        tokenizer = AutoTokenizer.from_pretrained(
            source_path,
            trust_remote_code=True,
            local_files_only=True,
        )
        model = AutoModelForCausalLM.from_pretrained(
            source_path,
            trust_remote_code=True,
            torch_dtype=torch.float16 if device == "cuda" else torch.float32,
            low_cpu_mem_usage=hasattr(torch, "float8_e4m3fn"),
            local_files_only=True,
        )
        model.to(device)
        model.eval()
        return {
            "backend": "transformers",
            "model": model,
            "tokenizer": tokenizer,
        }

    if source_path.lower().endswith(".safetensors"):
        if not model_id:
            raise RuntimeError(
                "这个 .safetensors 还不能确定模型家族和适配信息。"
            )
        from safetensors.torch import load_file

        config = AutoConfig.from_pretrained(
            model_id,
            trust_remote_code=True,
        )
        tokenizer = AutoTokenizer.from_pretrained(
            model_id,
            trust_remote_code=True,
        )
        model = AutoModelForCausalLM.from_config(
            config,
            trust_remote_code=True,
        )
        state_dict = load_file(source_path)
        missing, unexpected = model.load_state_dict(state_dict, strict=False)
        if len(missing) > len(state_dict) * 0.25:
            raise RuntimeError(
                "单个 .safetensors 与内置适配信息不匹配，请改用完整模型文件夹。"
            )
        model.to(device)
        if device == "cuda":
            model.half()
        model.eval()
        return {
            "backend": "transformers",
            "model": model,
            "tokenizer": tokenizer,
        }

    raise RuntimeError("不支持的对话模型格式。")


def load_asr(source_path, device="cpu"):
    import torch
    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

    processor = AutoProcessor.from_pretrained(
        source_path,
        local_files_only=True,
    )
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        source_path,
        torch_dtype=torch.float16 if device == "cuda" else torch.float32,
        low_cpu_mem_usage=hasattr(torch, "float8_e4m3fn"),
        local_files_only=True,
    )
    model.to(device)
    model.eval()
    return {
        "model": model,
        "processor": processor,
    }


def chat_llm(runtime, request, on_delta=None):
    messages = request.get("messages") or []
    if runtime["backend"] == "ctransformers":
        prompt = "\n".join(
            f"{message.get('role', 'user')}: {message.get('content', '')}"
            for message in messages
        )
        prompt += "\nassistant:"
        text = str(
            runtime["model"](
                prompt,
                max_new_tokens=int(request.get("max_new_tokens", 512)),
                temperature=float(request.get("temperature", 0.8)),
            )
        ).strip()
        if on_delta and text:
            on_delta(text)
        return {"text": text}
    if runtime["backend"] == "llama.cpp":
        result = runtime["model"].create_chat_completion(
            messages=messages,
            temperature=float(request.get("temperature", 0.8)),
            max_tokens=int(request.get("max_new_tokens", 512)),
        )
        text = result["choices"][0]["message"]["content"]
        if on_delta and text:
            on_delta(text)
        return {"text": text}

    import torch

    tokenizer = runtime["tokenizer"]
    model = runtime["model"]
    if getattr(tokenizer, "chat_template", None):
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt = "\n".join(
            f"{message.get('role', 'user')}: {message.get('content', '')}"
            for message in messages
        )
        prompt += "\nassistant:"
    inputs = tokenizer(prompt, return_tensors="pt")
    inputs = inputs.to(getattr(model, "device", torch.device("cpu")))
    max_new_tokens = int(request.get("max_new_tokens", 512))
    temperature = float(request.get("temperature", 0.8))
    do_sample = temperature > 0
    generate_kwargs = {
        "max_new_tokens": max_new_tokens,
        "do_sample": do_sample,
        "repetition_penalty": 1.08,
    }
    if do_sample:
        generate_kwargs["temperature"] = temperature
    else:
        generate_kwargs["temperature"] = None
        generate_kwargs["top_p"] = None
        generate_kwargs["top_k"] = None

    if on_delta is not None:
        from transformers import TextIteratorStreamer

        streamer = TextIteratorStreamer(
            tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
        )
        generate_kwargs["streamer"] = streamer

        def run_generate():
            with torch.inference_mode():
                model.generate(**inputs, **generate_kwargs)

        thread = threading.Thread(target=run_generate)
        thread.start()
        pieces = []
        for chunk in streamer:
            if not chunk:
                continue
            pieces.append(chunk)
            on_delta(chunk)
        thread.join()
        return {"text": "".join(pieces).strip()}

    with torch.inference_mode():
        output = model.generate(**inputs, **generate_kwargs)
    generated = output[0][inputs["input_ids"].shape[1] :]
    text = tokenizer.decode(generated, skip_special_tokens=True).strip()
    return {"text": text}


def transcribe_audio(runtime, request):
    import soundfile as sf
    import torch
    import torchaudio

    audio_path = request.get("audio_path")
    if not audio_path:
        raise RuntimeError("没有提供音频文件。")
    samples, sample_rate = sf.read(audio_path, always_2d=False)
    waveform = torch.tensor(samples, dtype=torch.float32)
    if waveform.ndim > 1:
        waveform = waveform.mean(dim=1)
    if sample_rate != 16000:
        waveform = torchaudio.functional.resample(
            waveform,
            sample_rate,
            16000,
        )
    processor = runtime["processor"]
    model = runtime["model"]
    inputs = processor(
        waveform.numpy(),
        sampling_rate=16000,
        return_tensors="pt",
    )
    inputs = inputs.to(model.device)
    input_features = inputs.get("input_features")
    if input_features is not None:
        inputs["input_features"] = input_features.to(
            next(model.parameters()).dtype
        )
    with torch.inference_mode():
        generated = model.generate(**inputs)
    text = processor.batch_decode(generated, skip_special_tokens=True)[0]
    return {"text": text.strip()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["llm", "asr"], required=True)
    parser.add_argument("--source-path", required=True)
    parser.add_argument("--model-id", default="")
    args = parser.parse_args()

    device = resolve_device(args.kind)

    def build_runtime(target_device):
        return (
            load_llm(args.source_path, args.model_id, target_device)
            if args.kind == "llm"
            else load_asr(args.source_path, target_device)
        )

    try:
        try:
            runtime = build_runtime(device)
        except Exception:
            if device != "cuda":
                raise
            print(
                f"显卡加载失败，回退 CPU：{traceback.format_exc()}",
                file=sys.stderr,
                flush=True,
            )
            device = "cpu"
            runtime = build_runtime("cpu")
        if args.kind == "llm":
            # 先跑一次极短生成，把显卡内核初始化挪到后台预热阶段，
            # 这样用户第一次说话时不用再额外等几秒。
            try:
                chat_llm(
                    runtime,
                    {
                        "messages": [{"role": "user", "content": "你好"}],
                        "max_new_tokens": 1,
                        "temperature": 0,
                    },
                )
            except Exception:
                print(traceback.format_exc(), file=sys.stderr, flush=True)
        send(
            {
                "type": "ready",
                "backend": runtime.get("backend", "transformers"),
                "device": device,
            }
        )
    except Exception as error:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        send({"type": "error", "error": str(error)})
        return 1

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            request_id = request.get("id")

            def emit_delta(chunk):
                if chunk:
                    send({"type": "delta", "id": request_id, "text": chunk})

            if args.kind == "llm":
                result = chat_llm(runtime, request, emit_delta)
            else:
                result = transcribe_audio(runtime, request)
            send({"id": request_id, **result})
        except Exception as error:
            send(
                {
                    "id": request.get("id") if "request" in locals() else "",
                    "error": str(error),
                    "traceback": traceback.format_exc(),
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
