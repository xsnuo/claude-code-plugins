"""bin/aload.py 的测试：本机起一个假的 Azure / 豆包接口，播放器换成 /usr/bin/true，不出声、不联网。
测试本身只在 macOS 和 Linux 上跑（假播放器是 shell 脚本）。

运行：/usr/bin/python3 -m unittest discover -s tests -v
"""
import base64
import http.server
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, 'bin', 'aload.py')
GOOD_KEY = 'good-key-1234'


class FakeTts(http.server.BaseHTTPRequestHandler):
    """/azure 收 SSML 回 mp3 字节；/doubao 回首尾相接的 JSON 对象。"""
    calls = []
    granted = set()

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        FakeTts.calls.append({'path': self.path, 'headers': dict(self.headers), 'body': body})
        if self.path.startswith('/azure'):
            if self.headers.get('Ocp-Apim-Subscription-Key') != GOOD_KEY:
                self.send_response(401)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Type', 'audio/mpeg')
            self.end_headers()
            self.wfile.write(b'ID3fake-mp3')
            return
        # 豆包：先查 Key，再查这个账号有没有这种资源的权限，最后查音色属不属于这种资源
        app_id = self.headers.get('X-Api-App-Id')
        key = self.headers.get('X-Api-Key') or self.headers.get('X-Api-Access-Key')
        if app_id and app_id != 'good-app':
            self.reply(401, {'header': {'code': 45000010, 'message': 'load grant: requested grant not found in SaaS storage'}})
            return
        if key != GOOD_KEY:
            self.reply(401, {'header': {'code': 45000010, 'message': 'Invalid X-Api-Key'}})
            return
        resource = self.headers.get('X-Api-Resource-Id')
        if resource not in FakeTts.granted:
            self.reply(403, {'header': {'code': 45000030,
                                        'message': f'[resource_id={resource}] requested resource not granted'}})
            return
        req = json.loads(body)
        speaker = req['req_params']['speaker']
        if voice_resource(speaker) != resource:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({'code': 55000000, 'message': 'resource ID is mismatched with speaker'}).encode())
            return
        self.send_response(200)
        self.end_headers()
        chunks = [base64.b64encode(b'part1').decode(), base64.b64encode('第二块'.encode()).decode()]
        out = ''.join(json.dumps({'code': 0, 'data': c, 'message': ''}) for c in chunks)
        out += json.dumps({'code': 20000000, 'message': 'OK', 'data': None})
        self.wfile.write(out.encode())

    def reply(self, code, obj):
        self.send_response(code)
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())


ALL_RESOURCES = {'seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-2.0', 'seed-icl-1.0'}


def voice_resource(speaker):
    """假接口里音色属于哪种资源：clone_voice / S_ 开头是复刻 2.0，_mars_ 是 1.0，其余是 2.0。"""
    if speaker == 'clone_voice' or speaker.startswith('S_'):
        return 'seed-icl-2.0'
    if '_mars_' in speaker:
        return 'seed-tts-1.0'
    return 'seed-tts-2.0'


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeTts)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        port = cls.server.server_address[1]
        cls.base = f'http://127.0.0.1:{port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeTts.calls = []
        FakeTts.granted = set(ALL_RESOURCES)
        self.home = tempfile.mkdtemp(prefix='aload-test-')
        self.env = dict(os.environ)
        self.slow_player = os.path.join(self.home, 'slow-player.sh')  # 假装播放 30 秒，忽略参数
        with open(self.slow_player, 'w') as f:
            f.write('#!/bin/sh\nexec sleep 30\n')
        os.chmod(self.slow_player, 0o755)
        self.env.update({
            'ALOAD_HOME': self.home,
            'ALOAD_PLAYER': '/usr/bin/true',
            'ALOAD_AZURE_ENDPOINT': f'{self.base}/azure',
            'ALOAD_DOUBAO_ENDPOINT': f'{self.base}/doubao',
        })

    def run_cli(self, *args, stdin=''):
        p = subprocess.run([sys.executable, '-I', SCRIPT, *args], input=stdin, capture_output=True, text=True,
                           env=self.env, timeout=30)
        return p

    def json_cli(self, *args, stdin=''):
        p = self.run_cli(*args, stdin=stdin)
        return json.loads(p.stdout.strip().splitlines()[-1])


class TestSplit(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, os.path.join(ROOT, 'bin'))
        import aload  # noqa: E402
        self.aload = aload

    def test_first_chunk_is_short_and_rest_grouped(self):
        text = '第一句话。' * 3 + '后面的内容比较长，' * 30 + '结束。'
        chunks = self.aload.split_text(text)
        self.assertLessEqual(len(chunks[0]), 60)
        self.assertEqual(''.join(chunks).replace(' ', ''), text.replace(' ', ''))
        for c in chunks:
            self.assertLessEqual(len(c), 400)

    def test_english_sentences_keep_spaces(self):
        chunks = self.aload.split_text('Hello there. How are you? Fine.', first=1000)
        self.assertEqual(chunks, ['Hello there. How are you? Fine.'])

    def test_iter_objects_handles_split_utf8(self):
        payload = (json.dumps({'code': 0, 'data': 'AA==', 'message': '第一'}, ensure_ascii=False)
                   + json.dumps({'code': 20000000, 'message': '完成'}, ensure_ascii=False)).encode()

        class Slow(io.RawIOBase):
            def __init__(self, data):
                self.data = data

            def read(self, n=-1):  # 每次只给 1 字节，必然切在汉字中间
                if not self.data:
                    return b''
                b, self.data = self.data[:1], self.data[1:]
                return b

        objs = list(self.aload.iter_objects(Slow(payload)))
        self.assertEqual([o['code'] for o in objs], [0, 20000000])
        self.assertEqual(objs[0]['message'], '第一')


class TestConfig(Base):
    def test_status_defaults(self):
        st = self.json_cli('status')
        self.assertEqual(st['provider'], 'azure')
        self.assertEqual(st['icon'], 'reply')
        self.assertFalse(st['keys']['azure']['set'])
        self.assertFalse(st['keys']['doubao']['set'])

    def test_use_voice_icon(self):
        self.assertEqual(self.json_cli('use', 'doubao')['provider'], 'doubao')
        self.assertEqual(self.json_cli('voice', 'my_voice')['voices']['doubao'], 'my_voice')
        self.assertEqual(self.json_cli('icon', 'hover')['icon'], 'hover')
        self.assertEqual(self.json_cli('icon', 'paragraph')['icon'], 'paragraph')
        self.assertEqual(self.json_cli('icon', 'reply')['icon'], 'reply')
        self.assertFalse(self.json_cli('icon', 'always')['ok'])
        self.assertFalse(self.json_cli('use', 'nope')['ok'])

    def test_old_always_icon_reads_as_reply(self):
        os.makedirs(os.path.join(self.home, '.config/aload'), exist_ok=True)
        with open(os.path.join(self.home, '.config/aload/config.json'), 'w') as f:
            json.dump({'provider': 'doubao', 'icon': 'always'}, f)
        st = self.json_cli('status')
        self.assertEqual((st['provider'], st['icon']), ('doubao', 'reply'))

    def test_setkey_verifies_then_saves_private(self):
        bad = self.json_cli('setkey', stdin=json.dumps({'provider': 'azure', 'key': 'wrong', 'region': 'eastasia'}))
        self.assertFalse(bad['ok'])
        self.assertEqual(bad['kind'], 'auth')
        self.assertFalse(os.path.exists(os.path.join(self.home, '.config/aload/credentials.json')))

        ok = self.json_cli('setkey', stdin=json.dumps({'provider': 'azure', 'key': GOOD_KEY, 'region': 'EastAsia'}))
        self.assertTrue(ok['ok'])
        self.assertEqual(ok['keys']['azure'], {'set': True, 'masked': '…1234', 'region': 'eastasia'})
        path = os.path.join(self.home, '.config/aload/credentials.json')
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode), 0o700)
        self.assertNotIn(GOOD_KEY, json.dumps(ok))  # 输出里只有末 4 位

    def test_setkey_azure_needs_region(self):
        res = self.json_cli('setkey', stdin=json.dumps({'provider': 'azure', 'key': GOOD_KEY, 'region': ''}))
        self.assertFalse(res['ok'])
        self.assertEqual(FakeTts.calls, [])

    def test_setkey_doubao_switches_provider(self):
        ok = self.json_cli('setkey', stdin=json.dumps({'provider': 'doubao', 'key': GOOD_KEY}))
        self.assertTrue(ok['ok'])
        self.assertEqual(ok['provider'], 'doubao')
        call = FakeTts.calls[-1]
        self.assertEqual(call['headers'].get('X-Api-Key'), GOOD_KEY)
        self.assertEqual(call['headers'].get('X-Api-Resource-Id'), 'seed-tts-2.0')

    def test_setkey_doubao_legacy_appid(self):
        ok = self.json_cli('setkey', stdin=json.dumps({'provider': 'doubao', 'key': GOOD_KEY, 'appId': 'good-app'}))
        self.assertTrue(ok['ok'])
        call = FakeTts.calls[-1]
        self.assertEqual(call['headers'].get('X-Api-App-Id'), 'good-app')
        self.assertEqual(call['headers'].get('X-Api-Access-Key'), GOOD_KEY)
        self.assertIsNone(call['headers'].get('X-Api-Key'))


    def test_doubao_only_1_0_granted_saves_key_and_says_why(self):
        FakeTts.granted = {'seed-tts-1.0'}
        res = self.json_cli('setkey', stdin=json.dumps({'provider': 'doubao', 'key': GOOD_KEY}))
        self.assertTrue(res['ok'])  # Key 是对的，存下来
        self.assertIn('不属于你已开通的「语音合成 1.0」', res['warning'])
        self.assertTrue(res['keys']['doubao']['set'])

    def test_doubao_nothing_granted_saves_key_and_says_open_it(self):
        FakeTts.granted = set()
        res = self.json_cli('setkey', stdin=json.dumps({'provider': 'doubao', 'key': GOOD_KEY}))
        self.assertTrue(res['ok'])
        self.assertIn('还没有豆包语音合成的使用权限', res['warning'])
        resources = [c['headers'].get('X-Api-Resource-Id') for c in FakeTts.calls]
        self.assertEqual(resources, ['seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-2.0', 'seed-icl-1.0'])

    def test_doubao_wrong_app_id_explains(self):
        res = self.json_cli('setkey', stdin=json.dumps({'provider': 'doubao', 'key': GOOD_KEY, 'appId': 'other-app'}))
        self.assertFalse(res['ok'])
        self.assertEqual(res['kind'], 'auth')
        self.assertIn('请把 App ID 留空', res['error'])
        self.assertEqual(len(FakeTts.calls), 1)  # Key 不对就不再试别的资源

    def test_doubao_invalid_key_explains(self):
        res = self.json_cli('setkey', stdin=json.dumps({'provider': 'doubao', 'key': 'nope'}))
        self.assertFalse(res['ok'])
        self.assertIn('Invalid X-Api-Key', res['error'])


class TestSpeak(Base):
    def save(self, provider, **cred):
        os.makedirs(os.path.join(self.home, '.config/aload'), exist_ok=True)
        with open(os.path.join(self.home, '.config/aload/credentials.json'), 'w') as f:
            json.dump({provider: {'key': GOOD_KEY, **cred}}, f)
        self.json_cli('use', provider)

    def lines(self, text):
        p = self.run_cli('speak', stdin=json.dumps({'text': text}))
        return [l for l in p.stdout.splitlines() if l != 'HB' and not l.startswith('SEGMENT ')], p

    def test_segments_play_in_order_and_report_progress(self):
        self.save('azure', region='eastasia')
        long = '第二段里的一句话。' * 40  # 要拆成好几次请求，SEGMENT 2 只报一次
        p = self.run_cli('speak', stdin=json.dumps({'segments': ['第一段。', '', long, '第三段。']}))
        out = [l for l in p.stdout.splitlines() if l != 'HB']
        self.assertEqual(out, ['PLAYING', 'SEGMENT 0', 'SEGMENT 2', 'SEGMENT 3', 'DONE'], p.stderr)
        texts = [c['body'].decode() for c in FakeTts.calls]
        self.assertIn('第一段。', texts[0])
        self.assertIn('第三段。', texts[-1])
        self.assertGreater(len(texts), 3)

    def test_no_key(self):
        out, p = self.lines('你好。')
        self.assertEqual(out, ['ERROR nokey azure 还没有设置Azure 语音的 Key'])
        self.assertEqual(p.returncode, 1)

    def test_azure_plays_all_chunks(self):
        self.save('azure', region='eastasia')
        text = '第一句。' + '第二部分很长，' * 40 + '完。'
        out, p = self.lines(text)
        self.assertEqual(out, ['PLAYING', 'DONE'], p.stderr)
        sent = [c for c in FakeTts.calls if c['path'].startswith('/azure')]
        self.assertGreater(len(sent), 1)
        ssml = sent[0]['body'].decode()
        self.assertIn("xml:lang='zh-CN'", ssml)
        self.assertIn("name='zh-CN-XiaoxiaoNeural'", ssml)
        tmp = os.path.join(self.home, '.cache/aload/tmp')
        self.assertEqual(os.listdir(tmp), [])  # 临时音频都删了
        self.assertFalse(os.path.exists(os.path.join(self.home, '.cache/aload/playing.pid')))

    def test_azure_escapes_ssml(self):
        self.save('azure', region='eastasia')
        self.lines('a < b & c > d。')
        self.assertIn('a &lt; b &amp; c &gt; d', FakeTts.calls[-1]['body'].decode())

    def test_azure_bad_key_is_auth(self):
        os.makedirs(os.path.join(self.home, '.config/aload'), exist_ok=True)
        with open(os.path.join(self.home, '.config/aload/credentials.json'), 'w') as f:
            json.dump({'azure': {'key': 'expired', 'region': 'eastasia'}}, f)
        out, _ = self.lines('你好。')
        self.assertTrue(out[0].startswith('ERROR auth azure '), out)

    def test_doubao_plays(self):
        self.save('doubao')
        out, p = self.lines('你好，豆包。')
        self.assertEqual(out, ['PLAYING', 'DONE'], p.stderr)

    def test_doubao_retries_clone_resource_and_remembers(self):
        self.save('doubao')
        self.json_cli('voice', 'clone_voice')
        out, p = self.lines('你好。')
        self.assertEqual(out, ['PLAYING', 'DONE'], p.stderr)
        resources = [c['headers'].get('X-Api-Resource-Id') for c in FakeTts.calls if c['path'].startswith('/doubao')]
        self.assertEqual(resources, ['seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-2.0'])
        with open(os.path.join(self.home, '.config/aload/config.json')) as f:
            self.assertEqual(json.load(f)['doubaoResource'], {'clone_voice': 'seed-icl-2.0'})
        FakeTts.calls = []
        self.lines('再来。')  # 记住了，直接用复刻资源
        resources = [c['headers'].get('X-Api-Resource-Id') for c in FakeTts.calls if c['path'].startswith('/doubao')]
        self.assertEqual(resources, ['seed-icl-2.0'])

    def test_doubao_1_0_voice_uses_1_0_resource(self):
        FakeTts.granted = {'seed-tts-1.0'}
        self.save('doubao')
        out, _ = self.lines('你好。')
        self.assertTrue(out[0].startswith('ERROR voice doubao '), out)  # 默认的 2.0 音色用不了
        self.json_cli('voice', 'zh_female_x_mars_bigtts')
        out, p = self.lines('你好。')
        self.assertEqual(out, ['PLAYING', 'DONE'], p.stderr)
        with open(os.path.join(self.home, '.config/aload/config.json')) as f:
            self.assertEqual(json.load(f)['doubaoResource']['zh_female_x_mars_bigtts'], 'seed-tts-1.0')

    def test_doubao_not_granted_is_grant_error(self):
        FakeTts.granted = set()
        self.save('doubao')
        out, _ = self.lines('你好。')
        self.assertTrue(out[0].startswith('ERROR grant doubao '), out)

    def test_new_speak_stops_previous(self):
        self.save('azure', region='eastasia')
        self.env['ALOAD_PLAYER'] = self.slow_player
        first = subprocess.Popen([sys.executable, '-I', SCRIPT, 'speak'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 text=True, env=self.env)
        first.stdin.write(json.dumps({'text': '第一段。'}))
        first.stdin.close()
        self.assertEqual(first.stdout.readline().strip(), 'HB')
        while first.stdout.readline().strip() != 'PLAYING':
            pass
        stopped = self.json_cli('stop')
        self.assertTrue(stopped['stopped'])
        self.assertEqual(first.wait(timeout=5), 0)
        first.stdout.close()

    def test_new_speak_takes_over_the_old_one(self):
        self.save('azure', region='eastasia')
        slow = dict(self.env, ALOAD_PLAYER=self.slow_player)
        first = subprocess.Popen([sys.executable, '-I', SCRIPT, 'speak'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 text=True, env=slow)
        first.stdin.write(json.dumps({'text': '第一段。'}))
        first.stdin.close()
        while first.stdout.readline().strip() != 'PLAYING':
            pass
        out, p = self.lines('第二段。')  # 新的一路照常念完
        self.assertEqual(out, ['PLAYING', 'DONE'], p.stderr)
        self.assertEqual(first.wait(timeout=5), 0)  # 旧的那路在心跳里发现换了人，自己停了
        first.stdout.close()

    def test_stop_with_nothing_playing(self):
        self.assertFalse(self.json_cli('stop')['stopped'])

    def test_wav_for_windows_and_linux(self):
        copy = os.path.join(self.home, 'copy-player.sh')  # 把要放的文件留一份，方便检查
        with open(copy, 'w') as f:
            f.write(f'#!/bin/sh\ncp "$1" "{self.home}/played"\n')
        os.chmod(copy, 0o755)
        self.env.update({'ALOAD_FORMAT': 'wav', 'ALOAD_PLAYER': copy})
        self.save('azure', region='eastasia')
        self.lines('你好。')
        headers = {k.lower(): v for k, v in FakeTts.calls[-1]['headers'].items()}
        self.assertEqual(headers.get('x-microsoft-outputformat'), 'riff-24khz-16bit-mono-pcm')
        self.save('doubao')
        out, p = self.lines('你好，豆包。')
        self.assertEqual(out, ['PLAYING', 'DONE'], p.stderr)
        sent = json.loads(FakeTts.calls[-1]['body'])
        self.assertEqual(sent['req_params']['audio_params'], {'format': 'pcm', 'sample_rate': 24000})
        with wave.open(os.path.join(self.home, 'played'), 'rb') as w:  # 豆包的 pcm 加上了 wav 文件头
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, 24000))
            self.assertEqual(w.readframes(w.getnframes()), b'part1' + '第二块'.encode())

    def test_closed_pipe_stops_playback(self):
        self.save('azure', region='eastasia')
        self.env['ALOAD_PLAYER'] = self.slow_player
        p = subprocess.Popen([sys.executable, '-I', SCRIPT, 'speak'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             text=True, env=self.env)
        p.stdin.write(json.dumps({'text': '第一段。'}))
        p.stdin.close()
        while p.stdout.readline().strip() != 'PLAYING':
            pass
        p.stdout.close()  # 插件那头没了
        self.assertEqual(p.wait(timeout=5), 0)


class TestLocalVoice(Base):
    """本机朗读（macOS 上叫 macos，Windows 上叫 windows，Linux 上叫 linux）：用假的 say 记下要念的文字。"""

    def setUp(self):
        super().setUp()
        self.said = os.path.join(self.home, 'said')
        fake = os.path.join(self.home, 'fake-say.sh')
        with open(fake, 'w') as f:
            f.write(f'#!/bin/sh\necho "ARGS:$*" >> "{self.said}"\ncat >> "{self.said}"\necho >> "{self.said}"\n')
        os.chmod(fake, 0o755)
        self.env['ALOAD_SAY'] = fake
        self.local = self.json_cli('status')['local']

    def test_status_lists_it_without_a_key(self):
        st = self.json_cli('status')
        self.assertIn(self.local, ('macos', 'windows', 'linux'))
        self.assertEqual(st['keys'][self.local], {'set': True})
        self.assertEqual(st['voices'][self.local], '')  # 空着：系统默认的声音
        self.assertFalse(self.json_cli('setkey', stdin=json.dumps({'provider': self.local, 'key': 'x'}))['ok'])

    def test_reads_each_paragraph_locally_without_calling_any_service(self):
        self.json_cli('use', self.local)
        p = self.run_cli('speak', stdin=json.dumps({'segments': ['第一段，Key 是 sk-test-123。', '', '第三段。']}))
        out = [l for l in p.stdout.splitlines() if l != 'HB']
        self.assertEqual(out, ['PLAYING', 'SEGMENT 0', 'SEGMENT 2', 'DONE'], p.stderr)
        with open(self.said, encoding='utf-8') as f:
            said = f.read()
        self.assertIn('第一段，Key 是 sk-test-123。', said)  # 不联网，原样念
        self.assertIn('第三段。', said)
        self.assertEqual(FakeTts.calls, [])

    def test_voice_goes_to_the_command_and_default_resets_it(self):
        self.json_cli('use', self.local)
        self.assertEqual(self.json_cli('voice', 'Eddy (中文（中国大陆）)')['voices'][self.local], 'Eddy (中文（中国大陆）)')
        self.run_cli('speak', stdin=json.dumps({'text': '你好。'}))
        with open(self.said, encoding='utf-8') as f:
            self.assertIn('ARGS:-v Eddy (中文（中国大陆）)', f.read())
        self.assertEqual(self.json_cli('voice', 'default')['voices'][self.local], '')

    def test_stop_ends_local_reading(self):
        slow = os.path.join(self.home, 'slow-say.sh')
        with open(slow, 'w') as f:
            f.write('#!/bin/sh\nexec sleep 30\n')
        os.chmod(slow, 0o755)
        self.env['ALOAD_SAY'] = slow
        self.json_cli('use', self.local)
        first = subprocess.Popen([sys.executable, '-I', SCRIPT, 'speak'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 text=True, env=self.env)
        first.stdin.write(json.dumps({'text': '一段很长的话。'}))
        first.stdin.close()
        while first.stdout.readline().strip() != 'PLAYING':
            pass
        self.assertTrue(self.json_cli('stop')['stopped'])
        self.assertEqual(first.wait(timeout=5), 0)
        first.stdout.close()


class TestPlayer(unittest.TestCase):
    """按系统挑播放器：在本进程里载入 aload.py，假装是别的系统。"""

    def load(self):
        spec = importlib.util.spec_from_file_location('aload_under_test', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_mac_uses_afplay(self):
        m = self.load()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ALOAD_PLAYER', None)
            m.IS_MAC, m.IS_WINDOWS = True, False
            self.assertEqual(m.make_player().argv, ['/usr/bin/afplay'])

    def test_linux_picks_the_first_player_it_finds(self):
        m = self.load()
        os.environ.pop('ALOAD_PLAYER', None)
        m.IS_MAC, m.IS_WINDOWS = False, False
        with mock.patch.object(m.shutil, 'which', lambda name: '/usr/bin/pw-play' if name == 'pw-play' else None):
            self.assertEqual(m.make_player().argv, ['pw-play'])
        with mock.patch.object(m.shutil, 'which', lambda name: None):
            self.assertIsNone(m.make_player())

    def test_custom_player_wins(self):
        m = self.load()
        with mock.patch.dict(os.environ, {'ALOAD_PLAYER': 'mpv --no-video'}):
            self.assertEqual(m.make_player().argv, ['mpv', '--no-video'])

    def test_format_follows_the_system(self):
        m = self.load()
        os.environ.pop('ALOAD_FORMAT', None)
        m.IS_MAC = True
        self.assertEqual(m.audio_format(), 'mp3')
        m.IS_MAC = False
        self.assertEqual(m.audio_format(), 'wav')


if __name__ == '__main__':
    unittest.main()
