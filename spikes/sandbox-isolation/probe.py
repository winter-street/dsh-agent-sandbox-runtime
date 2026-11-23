"""Bounded, synthetic probes. Runs as uid/gid 65534 inside the test sandbox."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import time


def text(path):
    try:
        return pathlib.Path(path).read_text().strip()
    except OSError:
        return None


def counters(path):
    raw = text(path)
    return dict((k, int(v)) for k, v in (line.split() for line in raw.splitlines())) if raw else {}


def network(peer_ip):
    result = {}
    try:
        result['domainAddresses'] = sorted({v[4][0] for v in socket.getaddrinfo('example.com', 80, type=socket.SOCK_STREAM)})
        result['domainResolved'] = True
    except OSError as error:
        result.update(domainResolved=False, domainError=type(error).__name__)
    try:
        with socket.create_connection(('example.com', 80), timeout=3) as client:
            client.sendall(b'HEAD / HTTP/1.0\r\nHost: example.com\r\n\r\n')
            result['domainConnected'] = bool(client.recv(128))
    except OSError as error:
        result.update(domainConnected=False, domainConnectError=type(error).__name__)
    try:
        with socket.create_connection((peer_ip, 8765), timeout=3) as client:
            client.sendall(b'GET / HTTP/1.0\r\nHost: controlled-peer\r\n\r\n')
            result['directIpConnected'] = client.recv(128).startswith(b'HTTP/1.0 200')
    except OSError as error:
        result.update(directIpConnected=False, directIpError=type(error).__name__)
    return result


def filesystem():
    result = {'uid': os.getuid(), 'gid': os.getgid(),
              'dockerSocketPresent': os.path.exists('/var/run/docker.sock'),
              'rootHomeReadable': os.access('/root', os.R_OK),
              'cgroupLimitWritable': os.access('/sys/fs/cgroup/memory.max', os.W_OK)}
    outside = pathlib.Path('/etc/runtime-isolation-synthetic-write')
    try:
        outside.write_text('synthetic probe')
        result['etcWriteDenied'] = False
        outside.unlink()
    except PermissionError:
        result['etcWriteDenied'] = True
    work = pathlib.Path('/tmp/runtime-isolation-work')
    work.write_text('synthetic probe')
    result['workWritePassed'] = work.read_text() == 'synthetic probe'
    work.unlink()
    result['processSecurity'] = {line.split(':', 1)[0]: line.split(':', 1)[1].strip()
                               for line in pathlib.Path('/proc/self/status').read_text().splitlines()
                               if line.startswith(('CapEff:', 'NoNewPrivs:', 'Seccomp:'))}
    return result


def resources():
    root = '/sys/fs/cgroup/'
    result = {'cpuMax': text(root + 'cpu.max'), 'memoryMax': text(root + 'memory.max'), 'swapMax': text(root + 'memory.swap.max'),
              'pidsMax': text(root + 'pids.max'), 'cgroup': text('/proc/self/cgroup')}
    # Never run a pressure test unless a small hard bound is observed in-kernel.
    if result['cpuMax'] == '50000 100000':
        before = counters(root + 'cpu.stat')
        worker = 'import time\ne=time.monotonic()+3\nwhile time.monotonic()<e: pass\n'
        started = time.monotonic()
        workers = [subprocess.Popen([sys.executable, '-c', worker]) for _ in range(2)]
        try:
            for child in workers:
                child.wait(timeout=8)
        finally:
            for child in workers:
                if child.poll() is None:
                    child.kill()
                    child.wait()
        elapsed = time.monotonic() - started
        after = counters(root + 'cpu.stat')
        result['cpuPressure'] = {'elapsedSeconds': elapsed,
                                 'usageSeconds': (after.get('usage_usec', 0) - before.get('usage_usec', 0)) / 1000000,
                                 'throttledPeriodsDelta': after.get('nr_throttled', 0) - before.get('nr_throttled', 0)}
    else:
        result['cpuPressureSkipped'] = 'Expected bounded cgroup v2 CPU quota was not observed'
    if (result['memoryMax'] == str(192 * 1024 * 1024) and result['swapMax'] is not None
            and result['swapMax'].isdigit() and int(result['swapMax']) <= 192 * 1024 * 1024):
        before = counters(root + 'memory.events')
        # Raise this child's kill preference; keep parent/execd alive. At most 512MiB requested,
        # only after observing that the memory+swap hard bounds total at most 384MiB.
        worker = ('import pathlib,time\n'
                  'pathlib.Path("/proc/self/oom_score_adj").write_text("1000")\n'
                  'chunks=[]\n'
                  'for _ in range(64):\n chunks.append(bytearray(8*1024*1024))\n time.sleep(.01)\n')
        child = subprocess.Popen([sys.executable, '-c', worker], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            code = child.wait(timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
        after = counters(root + 'memory.events')
        result['memoryPressure'] = {'childExitCode': code,
                                    'oomKillDelta': after.get('oom_kill', 0) - before.get('oom_kill', 0),
                                    'limitHitDelta': after.get('max', 0) - before.get('max', 0),
                                    'memoryPeak': text(root + 'memory.peak'), 'swapCurrent': text(root + 'memory.swap.current')}
    else:
        result['memoryPressureSkipped'] = 'Expected bounded cgroup v2 memory and swap limits were not observed'
    return result


report = {'network': network(sys.argv[1])}
if sys.argv[2] == 'deny':
    report.update(filesystem=filesystem(), resources=resources())
pathlib.Path('/tmp/runtime-isolation/result.json').write_text(json.dumps(report))
print('isolation-probe-finished', flush=True)
