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
NETWORK = pathlib.Path('/etc/pi-desktop-network.json')
PROXY = 'http://10.0.2.100:3128'
if NETWORK.exists() and json.loads(NETWORK.read_text()).get('mode') != 'off':
    ENV.update(http_proxy=PROXY, https_proxy=PROXY, HTTP_PROXY=PROXY, HTTPS_PROXY=PROXY, no_proxy='', NO_PROXY='')


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
    settings = json.load(sys.stdin)
    network = settings.get('network', {'mode': 'off', 'allowed_domains': []})
    NETWORK.write_text(json.dumps(network))
    connected = network['mode'] != 'off'
    proxy_file = pathlib.Path('/etc/profile.d/pi-desktop-proxy.sh')
    if connected:
        ENV.update(http_proxy=PROXY, https_proxy=PROXY, HTTP_PROXY=PROXY, HTTPS_PROXY=PROXY, no_proxy='', NO_PROXY='')
        proxy_file.write_text('export http_proxy=' + PROXY + '\nexport https_proxy=' + PROXY + '\nexport HTTP_PROXY=' + PROXY + '\nexport HTTPS_PROXY=' + PROXY + '\nexport no_proxy=\nexport NO_PROXY=\n')
    else:
        proxy_file.unlink(missing_ok=True)
        for name in ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY']:
            ENV.pop(name, None)
    # LightDM/Xfce was already running when the host configured this fresh VM.
    # GIO selects the environment resolver outside GNOME; gsettings alone is
    # insufficient for apps launched by the panel/Application Finder. Source
    # the same proxy settings at Xsession startup and restart the initial,
    # unused desktop once. Later runs preserve all open apps.
    session_env = pathlib.Path('/etc/X11/Xsession.d/90pi-desktop-proxy')
    first_connected_start = connected and not session_env.exists()
    session_env.write_text('if [ -r /etc/profile.d/pi-desktop-proxy.sh ]; then\n  . /etc/profile.d/pi-desktop-proxy.sh\nfi\n')
    if first_connected_start:
        subprocess.run(['systemctl', 'restart', 'lightdm'], check=True, timeout=20)
        for _ in range(150):
            if pathlib.Path('/tmp/.X11-unix/X0').exists() and pathlib.Path('/run/user/1000/bus').exists():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('Desktop proxy session did not become ready')
    # Desktop applications use GIO's proxy settings; shell tools inherit the
    # same endpoint. Changing these in the guest cannot bypass QEMU's routing.
    for schema, key, value in [
        ('org.gnome.system.proxy', 'mode', 'manual' if connected else 'none'),
        ('org.gnome.system.proxy', 'ignore-hosts', '[]'),
        ('org.gnome.system.proxy', 'use-same-proxy', 'true'),
        ('org.gnome.system.proxy.http', 'host', '10.0.2.100'),
        ('org.gnome.system.proxy.http', 'port', '3128'),
        ('org.gnome.system.proxy.https', 'host', '10.0.2.100'),
        ('org.gnome.system.proxy.https', 'port', '3128'),
    ]:
        subprocess.run(USER + ['gsettings', 'set', schema, key, value], env=ENV, check=True)
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
