import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { command, guestExec, rpc, startVM } from '../src/desktop/qemu.js';

const directory = resolve(process.env.DESKTOP_BUILD_DIR ?? '.data/desktop-build');
const destination = resolve(process.env.DESKTOP_BASE_IMAGE ?? '.data/desktop/ubuntu-hcu.qcow2');
if (directory.length > 75) throw new Error('Use a shorter DESKTOP_BUILD_DIR for QEMU Unix sockets');
await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
try { await access(destination); throw new Error('Base image already exists. Choose a new DESKTOP_BASE_IMAGE; never overwrite a base used by overlays.'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const baseUrl = 'https://cloud-images.ubuntu.com/noble/current/';
const filename = 'noble-server-cloudimg-amd64.img';
const checksumResponse = await fetch(baseUrl + 'SHA256SUMS');
if (!checksumResponse.ok) throw new Error('Could not read Ubuntu image checksums');
const checksum = (await checksumResponse.text()).split('\n').find(line => line.endsWith(filename))?.split(/\s+/)[0];
if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Ubuntu image checksum not found');
const source = join(directory, filename);
const hashFile = async (path: string) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
let valid = false;
try { valid = await hashFile(source) === checksum; } catch {}
if (!valid) {
  console.log('Downloading Ubuntu 24.04 LTS cloud image…');
  const response = await fetch(baseUrl + filename);
  if (!response.ok || !response.body) throw new Error('Image download failed');
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(source + '.partial', { mode: 0o600 }));
  if (await hashFile(source + '.partial') !== checksum) throw new Error('Ubuntu image checksum mismatch');
  await rename(source + '.partial', source);
}
const disk = join(directory, 'template.qcow2');
await command('qemu-img', ['convert', '-f', 'qcow2', '-O', 'qcow2', source, disk], 120_000);
await command('qemu-img', ['resize', disk, '16G']);
const assets: Record<string, Buffer> = {
  '/computer-use': await readFile('.data/hcu/computer-use'),
  '/runner.py': await readFile('deploy/desktop/runner.py'), '/tool.py': await readFile('deploy/desktop/tool.py'),
  '/HCU-LICENSE': await readFile('deploy/desktop/HCU-LICENSE'),
  '/HCU-NOTICES': await readFile('.data/vendor/hcu/THIRD_PARTY_NOTICES.md'),
};
await command('tar', ['-czf', join(directory, 'hcu-licenses.tar.gz'), '-C', resolve('.data/vendor/hcu'), 'licenses']);
assets['/hcu-licenses.tar.gz'] = await readFile(join(directory, 'hcu-licenses.tar.gz'));
// No credentials and no public listener. QEMU user networking reaches this
// seed server through its special 10.0.2.2 host address during image building.
const server = createServer((request, reply) => {
  const body = assets[request.url ?? ''];
  if (!body) { reply.writeHead(404); reply.end(); return; }
  reply.end(body);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const seed = `http://10.0.2.2:${port}`;
const files = (path: string, content: string, owner = 'root:root') => ({ path, content, owner, permissions: '0644' });
const userData = {
  users: [{ name: 'agent', uid: 1000, shell: '/bin/bash', lock_passwd: true, groups: ['audio', 'video'], sudo: false }],
  ssh_pwauth: false, disable_root: true, package_update: true,
  packages: ['qemu-guest-agent', 'xfce4', 'xfce4-terminal', 'lightdm', 'xserver-xorg', 'mousepad', 'galculator', 'epiphany-browser',
    'python3', 'python3-pil', 'python3-gi', 'gir1.2-atspi-2.0', 'gir1.2-gtk-3.0', 'gir1.2-gdkpixbuf-2.0', 'gir1.2-ibus-1.0',
    'ibus', 'ibus-gtk', 'ibus-gtk3', 'xdotool', 'wmctrl', 'x11-utils', 'dbus-user-session', 'curl'],
  write_files: [
    files('/etc/lightdm/lightdm.conf.d/50-pi.conf', '[Seat:*]\nautologin-user=agent\nautologin-user-timeout=0\nuser-session=xfce\n'),
    files('/home/agent/.xsessionrc', 'export GTK_IM_MODULE=ibus\nexport QT_IM_MODULE=ibus\nexport XMODIFIERS=@im=ibus\nexport QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1\n', 'agent:agent'),
    files('/home/agent/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<channel name="xfwm4" version="1.0"><property name="general" type="empty"><property name="use_compositing" type="bool" value="false"/></property></channel>\n', 'agent:agent'),
    files('/home/agent/.config/autostart/pi-display.desktop', '[Desktop Entry]\nType=Application\nName=Desktop display\nExec=sh -c "xrandr -s 1280x800; xset s off; xset -dpms; xfconf-query -c xfce4-session -p /general/SaveOnExit -n -t bool -s false"\n', 'agent:agent'),
    files('/home/agent/.config/autostart/ibus.desktop', '[Desktop Entry]\nType=Application\nName=Input method\nExec=ibus-daemon -drx\n', 'agent:agent'),
    files('/etc/polkit-1/rules.d/00-pi-desktop.rules', 'polkit.addRule(function(action, subject) { if (subject.user === "agent") return polkit.Result.NO; });\n'),
    files('/workspace/README.txt', 'Your private Linux desktop. Save deliverables under /workspace/outputs. Internet access is disabled.\n', 'agent:agent'),
  ],
  runcmd: [
    ['mkdir', '-p', '/usr/local/lib/pi-desktop', '/usr/local/share/hcu', '/workspace/outputs'],
    ['chown', '-R', 'agent:agent', '/workspace', '/home/agent'],
    ...['runner.py','tool.py'].map(name => ['curl', '--fail', '-o', `/usr/local/lib/pi-desktop/${name}`, seed + '/' + name]),
    ['curl', '--fail', '-o', '/usr/local/bin/computer-use', seed + '/computer-use'],
    ['curl', '--fail', '-o', '/usr/local/share/hcu/LICENSE', seed + '/HCU-LICENSE'],
    ['curl', '--fail', '-o', '/usr/local/share/hcu/THIRD_PARTY_NOTICES.md', seed + '/HCU-NOTICES'],
    ['curl', '--fail', '-o', '/usr/local/share/hcu/licenses.tar.gz', seed + '/hcu-licenses.tar.gz'],
    ['tar', '-xzf', '/usr/local/share/hcu/licenses.tar.gz', '-C', '/usr/local/share/hcu'],
    ['chmod', '755', '/usr/local/bin/computer-use'],
    ['systemctl', 'disable', '--now', 'ssh.socket', 'ssh.service'],
    ['systemctl', 'enable', 'qemu-guest-agent', 'lightdm'],
    ['systemctl', 'start', 'qemu-guest-agent', 'lightdm'],
    ['bash', '-euc', 'test -x /usr/local/bin/computer-use; /usr/local/bin/computer-use schema >/dev/null; python3 -c "import gi; from PIL import ImageGrab"; python3 -m py_compile /usr/local/lib/pi-desktop/runner.py /usr/local/lib/pi-desktop/tool.py; test -s /usr/local/share/hcu/LICENSE; test -d /usr/local/share/hcu/licenses; systemctl is-active lightdm qemu-guest-agent; touch /var/lib/pi-desktop-ready'],
  ],
};
assets['/meta-data'] = Buffer.from('instance-id: pi-desktop-template\nlocal-hostname: pi-desktop\n');
assets['/user-data'] = Buffer.from('#cloud-config\n' + JSON.stringify(userData));
await writeFile(join(directory, 'user-data.json'), JSON.stringify(userData, null, 2), { mode: 0o600 });
let started = false;
try {
  await startVM(directory, disk, 1536, ['-nic', 'user,model=virtio-net-pci', '-smbios', `type=1,serial=ds=nocloud-net;s=${seed}/` ]);
  started = true;
  console.log('Installing Xfce and HCU inside the VM. Progress: ' + join(directory, 'serial.log'));
  const deadline = Date.now() + 25 * 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try { await guestExec(join(directory, 'qga.sock'), '/usr/bin/test', ['-f', '/var/lib/pi-desktop-ready']); ready = true; break; }
    catch { await delay(3000); }
  }
  if (!ready) throw new Error('Desktop image provisioning timed out; inspect serial.log');
  await guestExec(join(directory, 'qga.sock'), '/usr/bin/python3', ['-c', "import pathlib; pathlib.Path('/etc/cloud/cloud-init.disabled').touch()"]);
  await guestExec(join(directory, 'qga.sock'), '/usr/bin/sync', []);
  await rpc(join(directory, 'qmp.sock'), 'system_powerdown');
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(1000);
    try { await rpc(join(directory, 'qmp.sock'), 'query-status'); }
    catch { started = false; break; }
  }
  if (started) throw new Error('Guest did not shut down cleanly');
  await command('qemu-img', ['convert', '-c', '-f', 'qcow2', '-O', 'qcow2', disk, destination + '.partial'], 300_000);
  await rename(destination + '.partial', destination);
  console.log('Desktop base image ready: ' + destination);
} finally {
  if (started) await rpc(join(directory, 'qmp.sock'), 'quit').catch(() => {});
  server.close();
}
