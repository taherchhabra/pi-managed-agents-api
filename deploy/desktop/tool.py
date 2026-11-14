#!/usr/bin/python3
"""Unprivileged guest tools. HCU owns all desktop input and reference state."""
import base64
import io
import hashlib
import json
import os
import pathlib
import signal
import socket
import stat
import subprocess
import sys
import tempfile
from PIL import Image, ImageGrab

ROOT = pathlib.Path('/workspace').resolve()


def file_path(value, output=False):
    root = ROOT / 'outputs' if output else ROOT
    if output and root.is_symlink():
        raise ValueError('Artifact directory cannot be a symlink')
    path = (root / value).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Path must be a file inside the workspace')
    return path


def jpeg(image):
    if image.width > 1920 or image.height > 1200:
        raise ValueError('Desktop resolution exceeds 1920 x 1200')
    out = io.BytesIO()
    image.convert('RGB').save(out, format='JPEG', quality=80)
    data = out.getvalue()
    if len(data) > 1024 * 1024:
        raise ValueError('Screenshot exceeds 1 MiB')
    # Do not resize: HCU coordinates must match the exact delivered pixels.
    return {'data': base64.b64encode(data).decode(), 'mimeType': 'image/jpeg', 'width': image.width, 'height': image.height}


def hcu(name, args, session):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(35)
        connection.connect('/run/user/1000/hcu/desktop.sock')
        reader = connection.makefile('rb')

        def rpc(id, method, params):
            connection.sendall((json.dumps({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}) + '\n').encode())
            line = reader.readline(4 * 1024 * 1024)
            result = json.loads(line)
            if result.get('id') != id or result.get('error'):
                raise RuntimeError('HCU transport failed: ' + str(result.get('error')))
            return result['result']

        hello = rpc(1, 'hello', {'session': session, 'display': ':0'})
        result = rpc(2, 'call', {'tool': name, 'args': args, 'format': 'text', 'daemon_instance': hello['instance_id']})
        text, images = [], []
        for block in result.get('content', []):
            if block['type'] == 'text':
                text.append(block['text'])
            elif block['type'] == 'image':
                if 'data' in block:
                    raw = base64.b64decode(block['data'], validate=True)
                else:
                    # HCU daemon/CLI transports return image files; MCP returns
                    # inline bytes. Read inside the guest, never on the host.
                    path = pathlib.Path(block['path']).resolve()
                    if not path.is_relative_to('/home/agent/.cache/pi-hcu-captures'):
                        raise ValueError('Unexpected HCU image path')
                    with path.open('rb') as image_file:
                        raw = image_file.read(3 * 1024 * 1024 + 1)
                if len(raw) > 3 * 1024 * 1024:
                    raise ValueError('HCU image exceeds limit')
                images.append(jpeg(Image.open(io.BytesIO(raw))))
        if len(images) > 1:
            raise ValueError('HCU returned too many images')
        return {'text': '\n'.join(text), 'isError': bool(result.get('isError')), 'images': images}


def run(request):
    name, args = request['name'], request.get('args', {})
    if name in ('AX', 'GUI'):
        return hcu(name, args, request['session'])
    if name == 'frame':
        # A preview does not touch HCU's latest observed frame or AX references.
        return jpeg(ImageGrab.grab(xdisplay=':0'))
    if name == 'bash':
        with tempfile.TemporaryFile() as output:
            p = subprocess.Popen(['bash', '-lc', args['command']], stdout=output, stderr=subprocess.STDOUT)
            try:
                code = p.wait(timeout=30)
            except subprocess.TimeoutExpired:
                p.kill()
                raise RuntimeError('Command exceeded 30 seconds')
            output.seek(0)
            data = output.read(65537)
            text = data[:65536].decode(errors='replace')
            if len(data) > 65536:
                text += '\n[output truncated at 64 KiB]'
            return {'text': text + (f'\n[exit code {code}]' if code else ''), 'isError': code != 0}
    if name in ('read_file', 'write_file'):
        path = file_path(args['path'])
        if name == 'read_file':
            with path.open('rb') as source:
                data = source.read(65537)
            if len(data) > 65536:
                raise ValueError('File exceeds 64 KiB')
            return {'text': data.decode()}
        data = args['content'].encode()
        if len(data) > 65536:
            raise ValueError('File exceeds 64 KiB')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {'text': f'Wrote {len(data)} bytes to {path}'}
    if name == 'artifact_list':
        root = ROOT / 'outputs'
        if root.is_symlink():
            raise ValueError('Artifact directory cannot be a symlink')
        result, total = [], 0
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not pathlib.Path(directory, d).is_symlink())
            for file in sorted(files):
                path = pathlib.Path(directory, file)
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode):
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('Artifacts must be regular files')
                total += info.st_size
                if info.st_size > 5 * 1024 * 1024 or total > 20 * 1024 * 1024 or len(result) >= 20:
                    raise ValueError('Artifact limit exceeded')
                with path.open('rb') as source:
                    data = source.read(5 * 1024 * 1024 + 1)
                if len(data) != info.st_size:
                    raise ValueError('Artifact changed during export')
                result.append({'path': str(path.relative_to(root)), 'size': info.st_size, 'sha256': hashlib.sha256(data).hexdigest()})
        return result
    if name == 'artifact_read':
        path = file_path(args['path'], output=True)
        with path.open('rb') as source:
            source.seek(args['offset'])
            return {'data': base64.b64encode(source.read(128 * 1024)).decode()}
    raise ValueError('Unknown tool')


try:
    print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=False))
except (ValueError, OSError, UnicodeError) as error:
    print(json.dumps({'text': str(error), 'isError': True}))
