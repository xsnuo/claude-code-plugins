#!/usr/bin/env python3
"""aload 的本地助手：调用朗读接口合成、用 afplay 播放、管理厂家和 Key。只用标准库（macOS 自带的 python3 即可）。

插件按下面的子命令调用它：

  speak             stdin: {"segments": ["第一段", "第二段", ...]}（或 {"text": "..."}），依次合成并连着播放。
                    stdout 一行一条：
                      HB                  心跳（每 0.3 秒），插件那头关了管道就自己停
                      PLAYING             开始出声
                      SEGMENT <i>         开始念第 i 段（从 0 数）
                      ERROR <类型> <厂家> <说明>  类型：nokey auth grant quota voice net other
                      DONE                念完
  status            打印当前配置（JSON，Key 只给末 4 位）
  use <厂家>        切换厂家：azure | doubao
  voice <音色>      设置当前厂家的音色
  icon <方式>       朗读按钮放哪：reply（每条回复末尾一个）| paragraph（每段一个）| hover（每段一个，悬停才显示）
  setkey            stdin: {"provider", "key", "region"?, "appId"?}；先真的合成一句验证，通过才保存
  stop              停掉正在念的（全机只有一个声音）

文件：
  ~/.config/aload/config.json        厂家、音色、图标方式
  ~/.config/aload/credentials.json   Key（目录 700、文件 600，只有你自己能读）
  ~/.cache/aload/                    临时音频、正在念的进程号、日志 aload.log

环境变量（测试用）：ALOAD_HOME 换掉 ~，ALOAD_PLAYER 换掉 afplay，
ALOAD_AZURE_ENDPOINT / ALOAD_DOUBAO_ENDPOINT 换掉接口地址。
"""
import base64
import codecs
import json
import os
import queue
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from xml.sax.saxutils import escape

HOME = os.environ.get('ALOAD_HOME') or os.path.expanduser('~')
CONFIG_DIR = os.path.join(HOME, '.config', 'aload')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.json')
CRED_FILE = os.path.join(CONFIG_DIR, 'credentials.json')
CACHE_DIR = os.path.join(HOME, '.cache', 'aload')
PID_FILE = os.path.join(CACHE_DIR, 'playing.pid')
LOG_FILE = os.path.join(CACHE_DIR, 'aload.log')
LOG_MAX_BYTES = 1024 * 1024

PROVIDERS = ('azure', 'doubao')
ICONS = ('reply', 'paragraph', 'hover')
PROVIDER_NAMES = {'azure': 'Azure 语音', 'doubao': '豆包语音 2.0'}
DEFAULTS = {
    'provider': 'azure',
    'icon': 'reply',
    'voices': {'azure': 'zh-CN-XiaoxiaoNeural', 'doubao': 'zh_female_zhixingnv_uranus_bigtts'},
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
        with open(LOG_FILE, 'a') as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{os.getpid()}] {msg}\n")
    except OSError:
        pass


def read_json(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path, data, mode):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    os.chmod(CONFIG_DIR, 0o700)
    tmp = f'{path}.{os.getpid()}.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, 'w') as f:
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
    keys = {}
    for p in PROVIDERS:
        c = creds.get(p) or {}
        info = {'set': bool(c.get('key'))}
        if c.get('key'):
            info['masked'] = masked(c['key'])
        if p == 'azure' and c.get('region'):
            info['region'] = c['region']
        if p == 'doubao' and c.get('appId'):
            info['appId'] = c['appId']
        keys[p] = info
    return {'ok': True, 'provider': cfg['provider'], 'icon': cfg['icon'], 'voices': cfg['voices'], 'keys': keys}


# ---------- 两家接口 ----------

def azure_endpoint(region):
    override = os.environ.get('ALOAD_AZURE_ENDPOINT')
    if override:
        return override
    domain = 'tts.speech.azure.cn' if region.startswith('china') else 'tts.speech.microsoft.com'
    return f'https://{region}.{domain}/cognitiveservices/v1'


def synth_azure(text, cred, voice):
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
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
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


def doubao_request(text, cred, voice, resource):
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
            'audio_params': {'format': 'mp3', 'sample_rate': 24000},
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
    return bytes(audio)


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


def synth_doubao(text, cred, voice, cfg=None):
    """依次试四种资源：没权限（grant）或音色不属于它（voice）就换下一种；Key 本身不对（auth）立刻报错。"""
    if not (cred.get('key') or '').strip():
        raise TtsError('nokey', '还没有设置豆包 Key')
    remembered = ((cfg or {}).get('doubaoResource') or {}).get(voice)
    granted, denied = [], []  # 有权限但音色不属于它的 / 没权限的
    for resource in resource_order(voice, remembered):
        try:
            audio = doubao_request(text, cred, voice, resource)
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


def synth(provider, text, cred, voice, cfg=None):
    if provider == 'azure':
        return synth_azure(text, cred, voice)
    if provider == 'doubao':
        return synth_doubao(text, cred, voice, cfg)
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

def player_argv(path):
    custom = os.environ.get('ALOAD_PLAYER')
    if custom:
        return shlex.split(custom) + [path]
    return ['/usr/bin/afplay', path]


def stop_previous():
    """全机只有一个声音：让上一个还在念的 aload.py 停下（核对进程身份才发信号）。"""
    try:
        with open(PID_FILE) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return False
    if pid == os.getpid():
        return False
    cmd = subprocess.run(['ps', '-ww', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout  # -ww：不截断长命令行
    if 'aload.py' not in cmd:
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return False
    for _ in range(20):  # 等它退出，最多 1 秒
        time.sleep(0.05)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
    return True


class Speaker:
    def __init__(self, provider, chunks, cred, voice, cfg):
        self.provider = provider
        self.chunks = chunks
        self.cred = cred
        self.voice = voice
        self.cfg = cfg
        self.out_lock = threading.Lock()
        self.ready = queue.Queue(maxsize=PREFETCH)
        self.player = None
        self.files = []
        self.tmp = os.path.join(CACHE_DIR, 'tmp')

    def emit(self, line):
        with self.out_lock:
            try:
                sys.stdout.write(line + '\n')
                sys.stdout.flush()
            except (BrokenPipeError, ValueError):
                self.stop()

    def stop(self, *_):
        player = self.player
        if player and player.poll() is None:
            try:
                player.kill()
            except OSError:
                pass
        self.cleanup()
        os._exit(0)

    def cleanup(self):
        for path in self.files:
            try:
                os.remove(path)
            except OSError:
                pass
        try:
            with open(PID_FILE) as f:
                if f.read().strip() == str(os.getpid()):
                    os.remove(PID_FILE)
        except OSError:
            pass

    def heartbeat(self):
        while True:
            self.emit('HB')
            time.sleep(HEARTBEAT_SECONDS)

    def synth_worker(self):
        for i, (seg, chunk) in enumerate(self.chunks):
            try:
                audio = synth(self.provider, chunk, self.cred, self.voice, self.cfg)
            except TtsError as e:
                self.ready.put(e)
                return
            except Exception as e:  # noqa: BLE001
                self.ready.put(TtsError('other', f'{type(e).__name__}: {e}'))
                return
            path = os.path.join(self.tmp, f'{os.getpid()}-{i}.mp3')
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
            self.player = subprocess.Popen(player_argv(path), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.player.wait()
            try:
                os.remove(path)
            except OSError:
                pass
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
    cred = load_creds().get(provider) or {}
    voice = cfg['voices'][provider]
    if not (cred.get('key') or '').strip() or (provider == 'azure' and not cred.get('region')):
        print(f'ERROR nokey {provider} 还没有设置{PROVIDER_NAMES[provider]}的 Key', flush=True)
        return 1
    os.makedirs(CACHE_DIR, exist_ok=True)
    stop_previous()
    with open(PID_FILE, 'w') as f:
        f.write(str(os.getpid()))
    speaker = Speaker(provider, chunks, cred, voice, cfg)
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
    if provider not in PROVIDERS:
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
    cmd = argv[1] if len(argv) > 1 else ''
    arg = argv[2] if len(argv) > 2 else ''
    if cmd == 'speak':
        return cmd_speak()
    if cmd == 'setkey':
        return cmd_setkey()
    if cmd == 'status':
        return reply(status())
    if cmd == 'stop':
        return reply({'ok': True, 'stopped': stop_previous()})
    cfg = load_config()
    if cmd == 'use':
        if arg not in PROVIDERS:
            return reply({'ok': False, 'error': f'厂家只能是 {" / ".join(PROVIDERS)}'})
        cfg['provider'] = arg
        save_config(cfg)
        return reply(status())
    if cmd == 'voice':
        if not arg:
            return reply({'ok': False, 'error': '请给出音色名'})
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
