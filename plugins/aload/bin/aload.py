#!/usr/bin/env python3
"""aload 的本地助手：调用朗读接口合成、播放、管理厂家和 Key。只用 Python 标准库，macOS、Windows、Linux 通用。

播放：macOS 用系统自带的 afplay 放 mp3；Windows 用标准库的 winsound 放 wav；
Linux 依次找 paplay、pw-play、aplay 放 wav。

厂家除了 azure、doubao，还有一个“本机朗读”，名字跟着系统走：macOS 上叫 macos（系统自带的 say，
用的是“辅助功能 → 朗读内容”里设的声音），Windows 上叫 windows（System.Speech），
Linux 上叫 linux（espeak-ng）。本机朗读不联网、不要 Key。

插件按下面的子命令调用它：

  speak             stdin: {"segments": ["第一段", "第二段", ...]}（或 {"text": "..."}），依次合成并连着播放。
                    stdout 一行一条：
                      HB                  心跳（每 0.3 秒），插件那头关了管道就自己停
                      PLAYING             开始出声
                      SEGMENT <i>         开始念第 i 段（从 0 数）
                      ERROR <类型> <厂家> <说明>  类型：nokey auth grant quota voice net other
                      DONE                念完
  status            打印当前配置（JSON，Key 只给末 4 位）
  use <厂家>        切换厂家：azure | doubao | 本机朗读（macos / windows / linux，看是什么系统）
  voice <音色>      设置当前厂家的音色（本机朗读填系统里的声音名，空着就用系统默认的声音）
  icon <方式>       朗读按钮放哪：reply（每条回复末尾一个）| paragraph（每段一个）| hover（每段一个，悬停才显示）
  setkey            stdin: {"provider", "key", "region"?, "appId"?}；先真的合成一句验证，通过才保存
  stop              停掉正在念的（全机只有一个声音：正在念的进程每次心跳都核对进程号文件，文件没了或换了人就自己停）

文件：
  ~/.config/aload/config.json        厂家、音色、图标方式
  ~/.config/aload/credentials.json   Key（目录 700、文件 600，只有你自己能读）
  ~/.cache/aload/                    临时音频、正在念的进程号、日志 aload.log

环境变量：ALOAD_PLAYER 换掉默认的播放器（命令加参数，音频文件路径接在最后）；
ALOAD_SAY 换掉本机朗读的命令（命令加参数，要念的文字从标准输入给）；
ALOAD_FORMAT 指定音频格式 mp3 或 wav（默认 macOS 用 mp3，其他用 wav）。
测试用：ALOAD_HOME 换掉 ~，ALOAD_AZURE_ENDPOINT / ALOAD_DOUBAO_ENDPOINT 换掉接口地址。
"""
import base64
import codecs
import io
import json
import os
import queue
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from xml.sax.saxutils import escape

IS_WINDOWS = os.name == 'nt'
IS_MAC = sys.platform == 'darwin'

HOME = os.environ.get('ALOAD_HOME') or os.path.expanduser('~')
CONFIG_DIR = os.path.join(HOME, '.config', 'aload')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.json')
CRED_FILE = os.path.join(CONFIG_DIR, 'credentials.json')
CACHE_DIR = os.path.join(HOME, '.cache', 'aload')
PID_FILE = os.path.join(CACHE_DIR, 'playing.pid')
LOG_FILE = os.path.join(CACHE_DIR, 'aload.log')
LOG_MAX_BYTES = 1024 * 1024

CLOUD = ('azure', 'doubao')
# 本机朗读：名字跟着系统走，只有这一个系统上的那一个
LOCAL = 'macos' if IS_MAC else ('windows' if IS_WINDOWS else 'linux')
PROVIDERS = CLOUD + (LOCAL,)
ICONS = ('reply', 'paragraph', 'hover')
PROVIDER_NAMES = {
    'azure': 'Azure 语音',
    'doubao': '豆包语音 2.0',
    'macos': 'macOS 系统朗读',
    'windows': 'Windows 系统朗读',
    'linux': 'Linux 系统朗读',
}
DEFAULTS = {
    'provider': 'azure',
    'icon': 'reply',
    # 本机朗读的音色空着：用系统默认的声音
    'voices': {'azure': 'zh-CN-XiaoxiaoNeural', 'doubao': 'zh_female_zhixingnv_uranus_bigtts', LOCAL: ''},
}
DOUBAO_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
# 豆包的四种语音合成资源：音色属于哪一种，请求头 X-Api-Resource-Id 就得写哪一种
DOUBAO_RESOURCES = ('seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-2.0', 'seed-icl-1.0')
DOUBAO_LABELS = {
    'seed-tts-2.0': '语音合成 2.0',
    'seed-tts-1.0': '语音合成 1.0',
    'seed-icl-2.0': '声音复刻 2.0',
    'seed-icl-1.0': '声音复刻 1.0',
}
DOUBAO_MISMATCH = 55000000  # 音色不存在，或音色和资源对不上
VERIFY_TEXT = '你好。'

FIRST_CHARS = 60  # 第一段尽量短，早点出声
CHUNK_CHARS = 220  # 之后每次请求的字数上限
HARD_CHARS = 400  # 一句话长到没有标点时，硬切的长度
PREFETCH = 2  # 念第 k 段时最多提前合成到第 k+2 段
HEARTBEAT_SECONDS = 0.3
SAMPLE_RATE = 24000


class TtsError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


# ---------- 日志、配置、Key ----------

def log(msg):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > LOG_MAX_BYTES:
            os.replace(LOG_FILE, LOG_FILE + '.1')
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{os.getpid()}] {msg}\n")
    except OSError:
        pass


def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path, data, mode):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    os.chmod(CONFIG_DIR, 0o700)
    tmp = f'{path}.{os.getpid()}.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def load_config():
    data = read_json(CONFIG_FILE)
    voices = dict(DEFAULTS['voices'])
    voices.update({k: v for k, v in (data.get('voices') or {}).items() if k in PROVIDERS and isinstance(v, str) and v})
    return {
        'provider': data.get('provider') if data.get('provider') in PROVIDERS else DEFAULTS['provider'],
        # 0.1.x 的 always（每段常显）是当时的默认值，现在的默认是 reply
        'icon': data.get('icon') if data.get('icon') in ICONS else DEFAULTS['icon'],
        'voices': voices,
        'doubaoResource': data.get('doubaoResource') or {},
    }


def save_config(cfg):
    write_json(CONFIG_FILE, cfg, 0o600)


def load_creds():
    return read_json(CRED_FILE)


def save_creds(creds):
    write_json(CRED_FILE, creds, 0o600)


def masked(key):
    key = key or ''
    return f'…{key[-4:]}' if len(key) > 4 else '…'


def status():
    cfg = load_config()
    creds = load_creds()
    keys = {LOCAL: {'set': True}}  # 本机朗读不要 Key
    for p in CLOUD:
        c = creds.get(p) or {}
        info = {'set': bool(c.get('key'))}
        if c.get('key'):
            info['masked'] = masked(c['key'])
        if p == 'azure' and c.get('region'):
            info['region'] = c['region']
        if p == 'doubao' and c.get('appId'):
            info['appId'] = c['appId']
        keys[p] = info
    return {'ok': True, 'provider': cfg['provider'], 'local': LOCAL, 'icon': cfg['icon'], 'voices': cfg['voices'], 'keys': keys}


# ---------- 两家接口 ----------

def audio_format():
    """macOS 用 mp3（体积小，afplay 直接放）；Windows 和 Linux 用 wav（winsound、paplay、aplay 都认）。"""
    fmt = os.environ.get('ALOAD_FORMAT')
    if fmt in ('mp3', 'wav'):
        return fmt
    return 'mp3' if IS_MAC else 'wav'


def pcm_to_wav(pcm):
    """豆包给的 pcm（24kHz、16 位、单声道）加上 wav 文件头。"""
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def azure_endpoint(region):
    override = os.environ.get('ALOAD_AZURE_ENDPOINT')
    if override:
        return override
    domain = 'tts.speech.azure.cn' if region.startswith('china') else 'tts.speech.microsoft.com'
    return f'https://{region}.{domain}/cognitiveservices/v1'


def synth_azure(text, cred, voice, fmt='mp3'):
    key = (cred.get('key') or '').strip()
    region = (cred.get('region') or '').strip().lower()
    if not key or not region:
        raise TtsError('nokey', '还没有设置 Azure Key')
    lang = '-'.join(voice.split('-')[:2]) or 'zh-CN'
    ssml = (f"<speak version='1.0' xml:lang='{escape(lang)}'>"
            f"<voice name='{escape(voice)}'>{escape(text)}</voice></speak>")
    url = azure_endpoint(region)
    req = urllib.request.Request(url, data=ssml.encode('utf-8'), method='POST', headers={
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3' if fmt == 'mp3' else 'riff-24khz-16bit-mono-pcm',
        'User-Agent': 'aload',
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            audio = resp.read()
    except urllib.error.HTTPError as e:
        body = e.read()[:300].decode('utf-8', 'replace')
        if e.code == 401:
            raise TtsError('auth', f'Azure 拒绝了这个 Key（HTTP 401），请确认 Key 和区域 {region} 对应同一个语音资源')
        if e.code == 429 or 'quota' in body.lower():
            raise TtsError('quota', f'Azure 额度或频率超限（HTTP {e.code}）')
        if e.code == 403:
            raise TtsError('auth', f'Azure 拒绝访问（HTTP 403）：{body or "没有说明"}')
        if e.code == 400:
            raise TtsError('voice', f'Azure 不接受这个请求（HTTP 400），音色名可能不对：{voice}')
        raise TtsError('other', f'Azure 返回 HTTP {e.code}：{body}')
    except urllib.error.URLError as e:
        raise TtsError('net', f'连不上 Azure（{url}）：{e.reason}；区域是否写对？')
    except OSError as e:
        raise TtsError('net', f'连不上 Azure：{e}')
    if not audio:
        raise TtsError('other', 'Azure 没有返回音频')
    return audio


def iter_objects(resp):
    """豆包返回首尾相接的 JSON 对象（不一定有换行）：边读边切出完整对象。

    网络分块可能切在汉字中间（UTF-8 一个汉字 3 字节），所以用增量解码器。
    """
    dec = json.JSONDecoder()
    text = codecs.getincrementaldecoder('utf-8')()
    buf = ''
    while True:
        data = resp.read(65536)
        if not data:
            buf += text.decode(b'', final=True)
            break
        buf += text.decode(data)
        while True:
            buf = buf.lstrip()
            if not buf:
                break
            try:
                obj, end = dec.raw_decode(buf)
            except json.JSONDecodeError:
                break
            yield obj
            buf = buf[end:]
    if buf.strip():
        raise TtsError('other', '豆包返回的数据不完整')


def brief(raw):
    """豆包的错误是 {"header": {"code", "message"}} 这样的 JSON：只留说明文字。"""
    try:
        obj = json.loads(raw)
    except ValueError:
        return raw.strip()
    head = obj.get('header') if isinstance(obj.get('header'), dict) else obj
    message = head.get('message') if isinstance(head, dict) else None
    return str(message) if message else raw.strip()


def doubao_request(text, cred, voice, resource, fmt='mp3'):
    key = (cred.get('key') or '').strip()
    app_id = (cred.get('appId') or '').strip()
    headers = {
        'X-Api-Resource-Id': resource,
        'X-Api-Request-Id': str(uuid.uuid4()),
        'Content-Type': 'application/json',
    }
    if app_id:  # 旧版控制台：AppID + Access Token
        headers['X-Api-App-Id'] = app_id
        headers['X-Api-Access-Key'] = key
    else:  # 新版控制台：API Key
        headers['X-Api-Key'] = key
    body = {
        'user': {'uid': 'aload'},
        'req_params': {
            'text': text,
            'speaker': voice,
            'audio_params': {'format': 'mp3' if fmt == 'mp3' else 'pcm', 'sample_rate': SAMPLE_RATE},
            'additions': json.dumps({'disable_markdown_filter': True}),
        },
    }
    url = os.environ.get('ALOAD_DOUBAO_ENDPOINT') or DOUBAO_URL
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        raw = brief(e.read()[:600].decode('utf-8', 'replace'))
        label = DOUBAO_LABELS.get(resource, resource)
        if e.code == 403 and re.search(r'not granted', raw, re.I):
            # Key 是对的，只是这个账号（或应用）没有这一种资源的权限
            raise TtsError('grant', f'这个 Key 没有「{label}」的使用权限（{raw}）')
        if e.code == 401 and re.search(r'grant not found', raw, re.I):
            if app_id:
                raise TtsError('auth', f'App ID 和 Key 对不上（{raw}）：新版控制台的 API Key 请把 App ID 留空；'
                                       '旧版请填同一个应用的 App ID 和 Access Token')
            raise TtsError('auth', f'Key 类型不对（{raw}）：旧版控制台的 Access Token 需要同时填 App ID')
        if e.code == 401 and re.search(r'invalid x-api-key', raw, re.I):
            raise TtsError('auth', '豆包不认这个 API Key（Invalid X-Api-Key），请检查是否复制完整')
        if e.code in (401, 403):
            raise TtsError('auth', f'豆包拒绝了这个 Key（HTTP {e.code}）：{raw or "没有说明"}')
        if e.code == 429:
            raise TtsError('quota', f'豆包额度或频率超限（HTTP 429）：{raw}')
        raise TtsError('other', f'豆包返回 HTTP {e.code}：{raw}')
    except urllib.error.URLError as e:
        raise TtsError('net', f'连不上豆包：{e.reason}')
    except OSError as e:
        raise TtsError('net', f'连不上豆包：{e}')
    audio = bytearray()
    with resp:
        for obj in iter_objects(resp):
            code = obj.get('code')
            if code not in (None, 0, 20000000):
                message = str(obj.get('message') or '')
                if code == DOUBAO_MISMATCH:
                    raise TtsError('voice', f'音色和资源对不上（{voice}，{resource}）')
                if re.search(r'auth|token|key|unauthori|鉴权|invalid', message, re.I):
                    raise TtsError('auth', f'豆包鉴权失败 {code}：{message}')
                if re.search(r'quota|exceed|limit|额度|欠费|余额', message, re.I):
                    raise TtsError('quota', f'豆包额度不足 {code}：{message}')
                raise TtsError('other', f'豆包返回错误 {code}：{message}')
            if obj.get('data'):
                audio += base64.b64decode(obj['data'])
    if not audio:
        raise TtsError('other', '豆包没有返回音频')
    return bytes(audio) if fmt == 'mp3' else pcm_to_wav(bytes(audio))


def resource_order(voice, remembered=None):
    """先试记住的；没有就按音色名猜（S_ 开头是复刻音色），其余的依次兜底。"""
    if voice.startswith('S_'):
        guess = ['seed-icl-2.0', 'seed-icl-1.0', 'seed-tts-2.0', 'seed-tts-1.0']
    else:
        guess = list(DOUBAO_RESOURCES)
    if remembered in guess:
        guess.remove(remembered)
        guess.insert(0, remembered)
    return guess


def synth_doubao(text, cred, voice, cfg=None, fmt='mp3'):
    """依次试四种资源：没权限（grant）或音色不属于它（voice）就换下一种；Key 本身不对（auth）立刻报错。"""
    if not (cred.get('key') or '').strip():
        raise TtsError('nokey', '还没有设置豆包 Key')
    remembered = ((cfg or {}).get('doubaoResource') or {}).get(voice)
    granted, denied = [], []  # 有权限但音色不属于它的 / 没权限的
    for resource in resource_order(voice, remembered):
        try:
            audio = doubao_request(text, cred, voice, resource, fmt)
        except TtsError as e:
            if e.kind == 'voice':
                granted.append(resource)
                continue
            if e.kind == 'grant':
                denied.append(resource)
                continue
            raise
        if granted or denied:
            log(f'豆包 {voice} 用的是 {resource}（没权限：{denied}，音色不属于：{granted}）')
        if cfg is not None and resource != remembered:
            cfg.setdefault('doubaoResource', {})[voice] = resource
            save_config(cfg)
        return audio
    if granted:
        names = '、'.join(DOUBAO_LABELS[r] for r in granted)
        raise TtsError('voice', f'音色 {voice} 不属于你已开通的「{names}」：用 /aload voice 换一个属于它的音色，'
                                f'或在火山引擎控制台开通这个音色所属的服务')
    raise TtsError('grant', '这个 Key 有效，但还没有豆包语音合成的使用权限：请在火山引擎控制台开通'
                            '「豆包语音合成模型 2.0」并确认状态为已开通（新账号可能需要先实名认证），开通后再点 🔊')


def synth(provider, text, cred, voice, cfg=None, fmt='mp3'):
    if provider == 'azure':
        return synth_azure(text, cred, voice, fmt)
    if provider == 'doubao':
        return synth_doubao(text, cred, voice, cfg, fmt)
    raise TtsError('other', f'不认识的厂家：{provider}')


# ---------- 切段 ----------

def split_text(text, first=FIRST_CHARS, rest=CHUNK_CHARS, hard=HARD_CHARS):
    """按句末标点切成几次请求：第一段短（早出声），之后每段不超过 rest 字。"""
    pieces = []
    for raw in re.split(r'(?<=[。！？；!?;…\n])', text):
        s = raw.strip()
        while len(s) > hard:  # 没有标点的超长句子：在逗号或空格处硬切
            cut = max(s.rfind('，', 0, hard), s.rfind(',', 0, hard), s.rfind(' ', 0, hard))
            cut = cut + 1 if cut > 0 else hard
            pieces.append(s[:cut].strip())
            s = s[cut:].strip()
        if s:
            pieces.append(s)
    chunks, buf = [], ''
    for s in pieces:
        limit = rest if chunks else first
        if buf and len(buf) + len(s) > limit:
            chunks.append(buf)
            buf = ''
        if buf and buf[-1].isascii() and not buf[-1].isspace() and s[0].isascii():
            buf += ' '  # 英文句子之间留空格
        buf += s
    if buf:
        chunks.append(buf)
    return chunks


# ---------- 播放 ----------

class ProcessPlayer:
    """外部播放器（afplay、paplay、aplay 或 ALOAD_PLAYER）：一个文件起一个进程，放完才返回。"""

    def __init__(self, argv):
        self.argv = argv
        self.proc = None

    def play(self, path):
        self.proc = subprocess.Popen(self.argv + [path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.proc.wait()

    def stop(self):
        proc = self.proc
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass


class WinSoundPlayer:
    """Windows：标准库的 winsound 在本进程里放 wav。异步开放，按 wav 的时长等它放完；停的时候让它马上闭嘴。"""

    def __init__(self):
        import winsound
        self.winsound = winsound
        self.stopped = threading.Event()

    def play(self, path):
        with wave.open(path, 'rb') as w:
            seconds = w.getnframes() / float(w.getframerate() or SAMPLE_RATE)
        ws = self.winsound
        ws.PlaySound(path, ws.SND_FILENAME | ws.SND_ASYNC | ws.SND_NODEFAULT)
        self.stopped.wait(seconds + 0.05)

    def stop(self):
        self.stopped.set()
        try:
            self.winsound.PlaySound(None, 0)
        except RuntimeError:
            pass


LINUX_PLAYERS = (['paplay'], ['pw-play'], ['aplay', '-q'])


def make_player():
    """按系统挑播放器；ALOAD_PLAYER 优先。Linux 上一个都找不到时返回 None。"""
    custom = os.environ.get('ALOAD_PLAYER')
    if custom:
        return ProcessPlayer(shlex.split(custom, posix=not IS_WINDOWS))
    if IS_MAC:
        return ProcessPlayer(['/usr/bin/afplay'])
    if IS_WINDOWS:
        return WinSoundPlayer()
    for argv in LINUX_PLAYERS:
        if shutil.which(argv[0]):
            return ProcessPlayer(argv)
    return None


# ---------- 本机朗读 ----------

# Windows：用系统自带的 System.Speech 念标准输入里的文字；音色从环境变量 ALOAD_VOICE 拿，免得引号出问题
WINDOWS_SPEAK = (
    '[Console]::InputEncoding = [Text.Encoding]::UTF8; '
    'Add-Type -AssemblyName System.Speech; '
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
    'if ($env:ALOAD_VOICE) { $s.SelectVoice($env:ALOAD_VOICE) }; '
    '$s.Speak([Console]::In.ReadToEnd())'
)
CJK = re.compile(r'[\u4e00-\u9fff]')


class SystemVoice:
    """本机朗读：一段文字起一个进程，文字从标准输入给，念完才返回；停的时候结束这个进程。

    macOS 用系统自带的 say，不指定音色时用“辅助功能 → 朗读内容”里设的声音和语速；
    Windows 用 System.Speech；Linux 用 espeak-ng（或 espeak）。
    """

    def __init__(self, argv_for, env=None):
        self.argv_for = argv_for  # 文字 → 命令行
        self.env = env
        self.proc = None
        self.stopped = False

    def say(self, text):
        if self.stopped:
            return
        self.proc = subprocess.Popen(self.argv_for(text), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.PIPE, env=self.env)
        _, err = self.proc.communicate(text.encode('utf-8'))
        if self.proc.returncode and not self.stopped:
            raise TtsError('other', f'系统朗读出错：{err.decode("utf-8", "replace").strip() or self.proc.returncode}')

    def stop(self):
        self.stopped = True
        proc = self.proc
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass


def system_voice(voice):
    """按系统挑本机朗读的命令；ALOAD_SAY 优先。Linux 上找不到 espeak-ng 时返回 None。"""
    custom = os.environ.get('ALOAD_SAY')
    if custom:
        base = shlex.split(custom, posix=not IS_WINDOWS)
        return SystemVoice(lambda text: base + (['-v', voice] if voice else []))
    if IS_MAC:
        return SystemVoice(lambda text: ['/usr/bin/say'] + (['-v', voice] if voice else []) + ['-f', '-'])
    if IS_WINDOWS:
        env = dict(os.environ, ALOAD_VOICE=voice or '')
        return SystemVoice(lambda text: ['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SPEAK], env)
    for name in ('espeak-ng', 'espeak'):
        if shutil.which(name):
            # 没指定音色时，有中文就用普通话的声音
            return SystemVoice(lambda text, name=name: [name] + (['-v', voice] if voice else (['-v', 'cmn'] if CJK.search(text) else []))
                               + ['--stdin'])
    return None


def mac_voices():
    """macOS 装了哪些声音：say -v '?' 每行是“名字  语言  # 示例”，名字里可能有空格和括号。"""
    try:
        out = subprocess.run(['/usr/bin/say', '-v', '?'], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    names = []
    for line in out.splitlines():
        m = re.match(r'^(.+?)\s{2,}[a-z]{2,3}_[A-Za-z0-9]+\s', line)
        if m:
            names.append(m.group(1).strip())
    return names


# 全机只有一个声音：正在念的进程把自己的进程号写进 PID_FILE，每次心跳核对一遍。
# 新开一路朗读就改写这个文件，stop 就删掉它；旧的那路发现文件不是自己的了，就自己停下。
# 这样不用 ps，也不用给别的进程发信号，各个系统都一样。

def read_owner():
    try:
        with open(PID_FILE, encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return None


def claim_voice():
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(PID_FILE, 'w', encoding='utf-8') as f:
        f.write(str(os.getpid()))


def stop_playing():
    """停掉全机正在念的那一路：删掉进程号文件，它在下一次心跳（0.3 秒内）就会停。有在念的返回 True。"""
    try:
        os.remove(PID_FILE)
        return True
    except OSError:
        return False


class Speaker:
    def __init__(self, provider, chunks, cred, voice, cfg, player, fmt):
        self.provider = provider
        self.chunks = chunks
        self.cred = cred
        self.voice = voice
        self.cfg = cfg
        self.player = player
        self.fmt = fmt
        self.me = str(os.getpid())
        self.out_lock = threading.Lock()
        self.ready = queue.Queue(maxsize=PREFETCH)
        self.files = []
        self.tmp = os.path.join(CACHE_DIR, 'tmp')

    def emit(self, line):
        with self.out_lock:
            try:
                sys.stdout.write(line + '\n')
                sys.stdout.flush()
            except (BrokenPipeError, ValueError, OSError):
                self.stop()

    def stop(self, *_):
        self.player.stop()
        self.cleanup()
        os._exit(0)

    def cleanup(self):
        for path in self.files:
            try:
                os.remove(path)
            except OSError:
                pass
        if read_owner() == self.me:
            try:
                os.remove(PID_FILE)
            except OSError:
                pass

    def heartbeat(self):
        # 插件那头关了管道（写不出去），或者进程号文件不是自己的了（别处开了新的一路、或者 stop），就停
        while True:
            self.emit('HB')
            if read_owner() != self.me:
                self.stop()
            time.sleep(HEARTBEAT_SECONDS)

    def synth_worker(self):
        for i, (seg, chunk) in enumerate(self.chunks):
            try:
                audio = synth(self.provider, chunk, self.cred, self.voice, self.cfg, self.fmt)
            except TtsError as e:
                self.ready.put(e)
                return
            except Exception as e:  # noqa: BLE001
                self.ready.put(TtsError('other', f'{type(e).__name__}: {e}'))
                return
            path = os.path.join(self.tmp, f'{self.me}-{i}.{self.fmt}')
            with open(path, 'wb') as f:
                f.write(audio)
            self.files.append(path)
            self.ready.put((seg, path))
        self.ready.put(None)

    def run(self):
        os.makedirs(self.tmp, exist_ok=True)
        threading.Thread(target=self.heartbeat, daemon=True).start()
        threading.Thread(target=self.synth_worker, daemon=True).start()
        started = False
        current = -1
        t0 = time.monotonic()
        while True:
            item = self.ready.get()
            if item is None:
                break
            if isinstance(item, TtsError):
                log(f'{self.provider} 失败（{item.kind}）：{item}')
                self.emit(f'ERROR {item.kind} {self.provider} {item}')
                self.cleanup()
                return 1
            seg, path = item
            if not started:
                started = True
                log(f'{self.provider} 首声 {time.monotonic() - t0:.2f}s，共 {len(self.chunks)} 次请求')
                self.emit('PLAYING')
            if seg != current:
                current = seg
                self.emit(f'SEGMENT {seg}')
            self.player.play(path)
            try:
                os.remove(path)
            except OSError:
                pass
        self.emit('DONE')
        self.cleanup()
        return 0


class LocalSpeaker(Speaker):
    """本机朗读：不用合成、不联网，一段一段直接念。停止、只放一路声音的规矩和 Speaker 一样。"""

    def __init__(self, provider, segments, voice, cfg, voice_proc):
        super().__init__(provider, [], {}, voice, cfg, voice_proc, 'local')
        self.segments = segments

    def run(self):
        threading.Thread(target=self.heartbeat, daemon=True).start()
        self.emit('PLAYING')
        try:
            for seg, text in self.segments:
                self.emit(f'SEGMENT {seg}')
                self.player.say(text)
        except TtsError as e:
            log(f'{self.provider} 失败（{e.kind}）：{e}')
            self.emit(f'ERROR {e.kind} {self.provider} {e}')
            self.cleanup()
            return 1
        self.emit('DONE')
        self.cleanup()
        return 0


def cmd_speak():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        payload = {}
    raw = payload.get('segments')
    segments = [str(s).strip() for s in raw] if isinstance(raw, list) else [str(payload.get('text') or '').strip()]
    # 每次请求记着它属于第几段，播到新的一段时报 SEGMENT
    chunks = [(i, piece) for i, seg in enumerate(segments) if seg for piece in split_text(seg)]
    if not chunks:
        print('DONE', flush=True)
        return 0
    cfg = load_config()
    provider = payload.get('provider') if payload.get('provider') in PROVIDERS else cfg['provider']
    voice = cfg['voices'].get(provider, '')
    if provider == LOCAL:
        voice_proc = system_voice(voice)
        if voice_proc is None:
            print(f'ERROR other {provider} 找不到能朗读的程序：请安装 espeak-ng（比如 sudo apt install espeak-ng）', flush=True)
            return 1
        claim_voice()  # 别处正在念的那一路，下一次心跳就会停
        speaker = LocalSpeaker(provider, [(i, seg) for i, seg in enumerate(segments) if seg], voice, cfg, voice_proc)
        signal.signal(signal.SIGTERM, speaker.stop)
        signal.signal(signal.SIGINT, speaker.stop)
        log(f'开始朗读：{provider}，{voice or "系统默认的声音"}，{len(segments)} 段 {sum(len(s) for s in segments)} 字')
        return speaker.run()
    cred = load_creds().get(provider) or {}
    if not (cred.get('key') or '').strip() or (provider == 'azure' and not cred.get('region')):
        print(f'ERROR nokey {provider} 还没有设置{PROVIDER_NAMES[provider]}的 Key', flush=True)
        return 1
    player = make_player()
    if player is None:
        print(f'ERROR other {provider} 找不到能放声音的程序：请安装 pulseaudio-utils（paplay）、pipewire（pw-play）'
              f'或 alsa-utils（aplay），也可以用环境变量 ALOAD_PLAYER 指定播放器', flush=True)
        return 1
    claim_voice()  # 别处正在念的那一路，下一次心跳就会停
    speaker = Speaker(provider, chunks, cred, voice, cfg, player, audio_format())
    signal.signal(signal.SIGTERM, speaker.stop)
    signal.signal(signal.SIGINT, speaker.stop)
    log(f'开始朗读：{provider}，{voice}，{len(segments)} 段 {sum(len(s) for s in segments)} 字')
    return speaker.run()


def cmd_setkey():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        payload = {}
    provider = payload.get('provider')
    if provider == LOCAL:
        return reply({'ok': False, 'kind': 'other', 'error': f'{PROVIDER_NAMES[LOCAL]}不需要 Key'})
    if provider not in CLOUD:
        return reply({'ok': False, 'kind': 'other', 'error': f'不认识的厂家：{provider}'})
    key = str(payload.get('key') or '').strip()
    if not key:
        return reply({'ok': False, 'kind': 'nokey', 'error': '请先填 Key'})
    cred = {'key': key}
    if provider == 'azure':
        region = str(payload.get('region') or '').strip().lower()
        if not re.fullmatch(r'[a-z0-9]+', region):
            return reply({'ok': False, 'kind': 'other', 'error': '请填 Azure 区域，例如 eastasia、eastus、chinanorth3'})
        cred['region'] = region
    else:
        app_id = str(payload.get('appId') or '').strip()
        if app_id:
            cred['appId'] = app_id
    cfg = load_config()
    warning = ''
    try:
        synth(provider, VERIFY_TEXT, cred, cfg['voices'][provider], cfg)
    except TtsError as e:
        if e.kind in ('grant', 'voice'):
            # Key 本身是对的：先存下来，免得去控制台开通后还要再输一遍
            warning = str(e)
            log(f'{provider} Key 有效，但：{e}')
        else:
            log(f'验证 {provider} Key 失败（{e.kind}）：{e}')
            return reply({'ok': False, 'kind': e.kind, 'error': str(e)})
    creds = load_creds()
    creds[provider] = cred
    save_creds(creds)
    cfg = load_config()
    cfg['provider'] = provider
    save_config(cfg)
    log(f'已保存 {provider} Key {masked(key)}')
    return reply({**status(), 'saved': provider, 'warning': warning})


def reply(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)
    return 0 if data.get('ok') else 1


def main(argv):
    # 和插件之间的管道一律用 UTF-8（Windows 默认是系统代码页，中文会乱）
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError):
            pass
    cmd = argv[1] if len(argv) > 1 else ''
    arg = argv[2] if len(argv) > 2 else ''
    if cmd == 'speak':
        return cmd_speak()
    if cmd == 'setkey':
        return cmd_setkey()
    if cmd == 'status':
        return reply(status())
    if cmd == 'stop':
        return reply({'ok': True, 'stopped': stop_playing()})
    cfg = load_config()
    if cmd == 'use':
        if arg not in PROVIDERS:
            return reply({'ok': False, 'error': f'厂家只能是 {" / ".join(PROVIDERS)}'})
        cfg['provider'] = arg
        save_config(cfg)
        return reply(status())
    if cmd == 'voice':
        arg = ' '.join(argv[2:]).strip()
        if not arg:
            return reply({'ok': False, 'error': '请给出音色名'})
        if cfg['provider'] == LOCAL and arg.lower() in ('default', '默认', '系统默认'):
            arg = ''  # 回到系统默认的声音
        elif cfg['provider'] == 'macos' and not os.environ.get('ALOAD_SAY'):
            names = mac_voices()
            match = next((n for n in names or [] if n.lower() == arg.lower()), None)
            if names is not None and match is None:
                zh = [n for n in names if '中文' in n][:8]
                hint = f'，中文的声音有：{"、".join(zh)}' if zh else ''
                return reply({'ok': False, 'error': f'这台 Mac 上没有叫“{arg}”的声音{hint}'})
            arg = match or arg
        cfg['voices'][cfg['provider']] = arg
        save_config(cfg)
        return reply(status())
    if cmd == 'icon':
        if arg not in ICONS:
            return reply({'ok': False, 'error': f'按钮方式只能是 {" / ".join(ICONS)}'})
        cfg['icon'] = arg
        save_config(cfg)
        return reply(status())
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
