#!/usr/bin/python3
"""Root-owned QGA entry point. Tool code always runs as the desktop user.

Only the trusted host invokes this runner, over a private virtio channel.
The guest receives no control-plane or model-provider credentials.
"""
import json
import fcntl
import os
import pathlib
import signal
import subprocess
import sys
import time

ROOT = pathlib.Path('/run/pi-desktop')
ROOT.mkdir(mode=0o700, exist_ok=True)
ENV = dict(os.environ, HOME='/home/agent', DISPLAY=':0', XAUTHORITY='/home/agent/.Xauthority',
           XDG_RUNTIME_DIR='/run/user/1000', DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus',
           GTK_IM_MODULE='ibus', QT_IM_MODULE='ibus', XMODIFIERS='@im=ibus',
           COMPUTER_USE_OUTPUT_DIR='/home/agent/.cache/pi-hcu-captures')
USER = ['runuser', '-u', 'agent', '--']


def kill_group(pid):
    try:
        os.killpg(int(pid), signal.SIGKILL)
    except ProcessLookupError:
        pass


operation, epoch = sys.argv[1], int(sys.argv[2])
lock = open(ROOT / 'lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX)
active_path = ROOT / 'active'
active = int(active_path.read_text()) if active_path.exists() else 0
if operation == 'stop':
    # Kill the HCU daemon/provider as well as dispatchers: killing only an MCP
    # caller does not cancel input already queued in a persistent daemon.
    if active <= epoch:
        active_path.write_text('0')
        for path in ROOT.glob('hcu.pid'):
            kill_group(path.read_text())
            path.unlink(missing_ok=True)
    for path in ROOT.glob(str(epoch) + '-*.pid'):
        kill_group(path.read_text())
        path.unlink(missing_ok=True)
    print('{}')
elif operation == 'start':
    if (ROOT / 'hcu.pid').exists():
        raise RuntimeError('Previous HCU generation is still active')
    # GDK root-window capture can be black under Xfce compositing on QEMU's
    # framebuffer driver. Configure this before HCU observes any coordinates.
    # The X socket and user bus precede the window manager on a fresh boot.
    for _ in range(150):
        wm = subprocess.run(USER + ['xprop', '-root', '_NET_SUPPORTING_WM_CHECK'], env=ENV, capture_output=True, text=True)
        if wm.returncode == 0 and 'window id #' in wm.stdout:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError('Desktop window manager did not become ready')
    subprocess.run(USER + ['xfconf-query', '-c', 'xfwm4', '-p', '/general/use_compositing', '-n', '-t', 'bool', '-s', 'false'], env=ENV, check=True)
    subprocess.run(USER + ['xrandr', '-s', '1280x800'], env=ENV, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(USER + ['mkdir', '-p', '/run/user/1000/hcu'], env=ENV, check=True)
    # The per-desktop counters file survives daemon restarts; old references
    # cannot silently start referring to different controls.
    socket = pathlib.Path('/run/user/1000/hcu/desktop.sock')
    socket.unlink(missing_ok=True)
    log = open(ROOT / 'hcu.log', 'ab')
    p = subprocess.Popen(USER + ['/usr/local/bin/computer-use', 'serve', '--socket', str(socket), '--idle-timeout', '8760h'],
                         env=ENV, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    (ROOT / 'hcu.pid').write_text(str(p.pid))
    active_path.write_text(str(epoch))
    for _ in range(100):
        if socket.exists():
            break
        if p.poll() is not None:
            raise RuntimeError('HCU daemon failed to start')
        time.sleep(0.1)
    else:
        kill_group(p.pid)
        raise RuntimeError('HCU daemon did not become ready')
    print('{}')
elif operation == 'run':
    request = json.load(sys.stdin)
    if epoch != active and request.get('name') != 'frame':
        raise RuntimeError('Guest generation has been fenced')
    p = subprocess.Popen(USER + ['/usr/bin/python3', '/usr/local/lib/pi-desktop/tool.py'],
                         env=ENV, cwd='/workspace', stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    marker = ROOT / (str(epoch) + '-' + str(p.pid) + '.pid')
    marker.write_text(str(p.pid))
    fcntl.flock(lock, fcntl.LOCK_UN)
    try:
        output, error = p.communicate(json.dumps(request).encode(), timeout=40)
        if p.returncode:
            raise RuntimeError(error.decode(errors='replace')[:1000])
        sys.stdout.buffer.write(output)
    finally:
        kill_group(p.pid)
        marker.unlink(missing_ok=True)
else:
    raise ValueError('Unknown operation')
