import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SAMPLES = ROOT / 'samples'
LANGUAGES = {
    'zh': ('Tingting', '新鲜的青草通常是什么颜色？'),
    'de': ('Anna', 'Welche Farbe hat frisches Gras normalerweise?'),
    'ja': ('Kyoko', '草は普通何色ですか。'),
    'en': ('Samantha', 'What color is fresh grass usually?'),
}
MODEL_HOME = Path(os.environ.get('MODEL_HOME', '~/models-docker-mac/models')).expanduser()
ASR_MODEL = str(MODEL_HOME / 'Qwen3-ASR-1.7B-8bit')
CHAT_MODEL = str(MODEL_HOME / 'Qwen3.6-35B-A3B-4bit')
TTS_MODEL = str(MODEL_HOME / 'Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit')


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def make_samples():
    SAMPLES.mkdir(exist_ok=True)
    failed = False
    for language, (voice, question) in LANGUAGES.items():
        target = SAMPLES / f'{language}.wav'
        if target.exists():
            print(f'保留已有录音：{target.name}')
            continue
        try:
            with tempfile.TemporaryDirectory(dir=SAMPLES) as temp:
                source = Path(temp) / 'sample.aiff'
                wav_file = Path(temp) / 'sample.wav'
                subprocess.run(['say', '-v', voice, '-r', '155', '-o', str(source), question], check=True)
                subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', str(source), str(wav_file)], check=True)
                with wave.open(str(wav_file), 'rb') as recording:
                    if recording.getnframes() < recording.getframerate() // 2:
                        raise ValueError('输出不足半秒')
                wav_file.replace(target)
                print(f'已生成：{target.name}')
        except (OSError, ValueError, wave.Error, subprocess.CalledProcessError) as error:
            print(f'{language} 未生成，请按 README 自录：{error}', file=sys.stderr)
            failed = True
    return int(failed)


def post(url, args, output, record, stage):
    started = time.monotonic()
    result = subprocess.run(['curl', '--noproxy', '*', '-sS', '--connect-timeout', '5', '--max-time', '300', '-o', str(output), '-w', '%{http_code}', *args, url], capture_output=True, text=True)
    record[stage] = {'status': result.stdout, 'seconds': round(time.monotonic() - started, 2)}
    if result.returncode or not result.stdout.startswith('2'):
        raise ValueError(f'{stage} 请求失败：HTTP {result.stdout}，{result.stderr.strip()}；见 {output.name}')


def json_args(data):
    return ['-H', 'Content-Type: application/json', '--data-binary', json.dumps(data, ensure_ascii=False)]


def run():
    missing = [str(SAMPLES / f'{lang}.wav') for lang in LANGUAGES if not (SAMPLES / f'{lang}.wav').is_file()]
    if missing:
        print('缺少输入录音；请先运行 --make-samples 或按 README 自录：\n' + '\n'.join(missing), file=sys.stderr)
        return 1
    out = ROOT / ('results-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    out.mkdir()
    history = [{'role': 'system', 'content': 'Answer the latest question in the language in which it is asked. Give one short natural sentence. Do not translate or name the language.'}]
    results = []
    print(f'测试输出：{out}', flush=True)
    for index, expected in enumerate(('zh', 'de', 'ja', 'zh', 'en'), 1):
        folder = out / f'{index:02}-{expected}'
        folder.mkdir()
        row = {'round': index, 'expected_for_review_only': expected, 'voice': 'Vivian'}
        results.append(row)
        print(f'{folder.name}：测试中…', flush=True)
        try:
            asr = folder / 'asr.json'
            post('http://127.0.0.1:8002/v1/audio/transcriptions', ['-F', f'file=@{SAMPLES / (expected + ".wav")};filename=sample.wav;type=audio/wav', '-F', f'model={ASR_MODEL}', '-F', 'response_format=verbose_json'], asr, row, 'asr')
            transcript = json.loads(asr.read_bytes())
            text = (transcript.get('text') or '').strip()
            row.update(transcript=text, language=transcript.get('language'), segment_languages=[seg['language'] for seg in transcript.get('segments') or [] if isinstance(seg, dict) and 'language' in seg])
            if not text:
                raise ValueError('无转写文本，不继续本轮')
            question = {'role': 'user', 'content': text}
            chat = folder / 'chat.json'
            post('http://127.0.0.1:8000/v1/chat/completions', json_args({'model': CHAT_MODEL, 'messages': history + [question], 'stream': False, 'temperature': 0.2, 'max_tokens': 768}), chat, row, 'chat')
            content = json.loads(chat.read_bytes())['choices'][0]['message'].get('content') or ''
            reply = re.sub(r'<think>.*?</think>', '', content, flags=re.S).strip()
            if not reply or '<think>' in reply:
                raise ValueError('无完整可见回复，不进行本轮合成')
            row['reply'] = reply
            history.extend([question, {'role': 'assistant', 'content': reply}])
            audio = folder / 'tts-response.bin'
            post('http://127.0.0.1:8004/v1/audio/speech', json_args({'model': TTS_MODEL, 'voice': 'Vivian', 'input': reply, 'response_format': 'wav'}), audio, row, 'tts')
            with audio.open('rb') as sound:
                header = sound.read(12)
            if header[:4] != b'RIFF' or header[8:12] != b'WAVE' or audio.stat().st_size <= 44:
                raise ValueError('响应不是有效的常规 WAV 文件头，保留原始响应待排查')
            audio.rename(folder / 'tts.wav')
            row['result'] = '已返回音频，待人工检查识别标签、文字与试听'
        except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError) as error:
            row['error'] = str(error)
        print(row.get('error') or row['result'], flush=True)
        save_json(out / 'report.json', results)
    print('请按 README 试听并回传报告。')
    return int(any('error' in row for row in results))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Mac Studio 本地模型四语切换测试')
    parser.add_argument('--make-samples', action='store_true', help='只生成四段本地测试录音，不调用模型')
    options = parser.parse_args()
    sys.exit(make_samples() if options.make_samples else run())
