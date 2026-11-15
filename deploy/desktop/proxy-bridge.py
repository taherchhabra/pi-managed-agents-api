#!/usr/bin/python3
"""Fixed QEMU guestfwd endpoint. Relays stdio to one session's Unix proxy.

No guest-supplied commands, paths, credentials, or host TCP listener. A lock
slot bounds long-lived bridge processes; the service cgroup bounds all tasks.
"""
import fcntl
import os
import pathlib
import selectors
import signal
import socket
import sys

def main():
    path = pathlib.Path(sys.argv[1])
    slot = None
    for index in range(32):
        candidate = open(path.parent / ('proxy-slot-' + str(index)), 'a')
        try:
            fcntl.flock(candidate, fcntl.LOCK_EX | fcntl.LOCK_NB)
            slot = candidate
            break
        except BlockingIOError:
            candidate.close()
    if slot is None:
        sys.exit(1)
    signal.alarm(300)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect(str(path))
        connection.settimeout(60)
        with selectors.DefaultSelector() as select:
            select.register(sys.stdin.buffer, selectors.EVENT_READ)
            select.register(connection, selectors.EVENT_READ)
            while True:
                ready = select.select(60)
                if not ready:
                    break
                for key, _ in ready:
                    if key.fileobj is connection:
                        data = connection.recv(65536)
                        if not data:
                            sys.exit(0)
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    else:
                        data = os.read(sys.stdin.fileno(), 65536)
                        if not data:
                            sys.exit(0)
                        connection.sendall(data)


try:
    main()
except (OSError, ValueError):
    # libslirp connects stderr to the guest stream too. Do not send host paths.
    sys.exit(1)
