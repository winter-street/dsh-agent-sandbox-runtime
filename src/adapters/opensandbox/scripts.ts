/** Fixed scripts run inside the sandbox only; no user text is interpolated into shell commands. */
export const RUNNER_SCRIPT = String.raw`import json, os, pathlib, signal, subprocess, sys, threading

root = pathlib.Path(sys.argv[1])
max_log = int(sys.argv[2])
if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
    raise RuntimeError('Runner requires Linux pidfd support and Python >= 3.9')
out = root / 'outputs'
out.mkdir(exist_ok=True)
truncated = {'stdout': False, 'stderr': False}
def drain(source, name):
    written = 0
    with (root / (name + '.log')).open('wb') as target:
        while True:
            chunk = source.read(8192)
            if not chunk:
                break
            remaining = max(0, max_log - written)
            target.write(chunk[:remaining])
            written += min(remaining, len(chunk))
            if len(chunk) > remaining:
                truncated[name] = True
    source.close()

env = dict(os.environ)
env['AGENT_INPUT_DIR'] = str(root / 'inputs')
env['AGENT_OUTPUT_DIR'] = str(out)
child = subprocess.Popen([sys.executable, str(root / 'main.py')], cwd=out,
    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
def stop_group_peers():
    # Keep the child inside execd's command process group so server timeout
    # and interrupt also reach it. Do not introduce an escaping session.
    group, own_pid = os.getpgrp(), os.getpid()
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit() or int(entry.name) == own_pid:
            continue
        pid = int(entry.name)
        try:
            handle = os.pidfd_open(pid)
        except (ProcessLookupError, PermissionError):
            continue
        try:
            if os.getpgid(pid) == group:
                signal.pidfd_send_signal(handle, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        finally:
            os.close(handle)
def stop_child(signum, frame):
    stop_group_peers()
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, stop_child)
signal.signal(signal.SIGINT, stop_child)
threads = [threading.Thread(target=drain, args=(child.stdout, 'stdout'), daemon=True),
           threading.Thread(target=drain, args=(child.stderr, 'stderr'), daemon=True)]
for thread in threads:
    thread.start()
try:
    code = child.wait()
finally:
    stop_group_peers()
for thread in threads:
    thread.join(timeout=2)
if any(thread.is_alive() for thread in threads):
    raise RuntimeError('Child log streams remain open after process group cleanup')
(root / 'logs.json').write_text(json.dumps({'truncated': any(truncated.values())}))
raise SystemExit(code if code >= 0 else 128 - code)
`;

/** Open each component with O_NOFOLLOW. The collector does not trust a user-written manifest. */
export const COLLECTOR_SCRIPT = String.raw`import base64, json, os, stat, sys

root, max_files, max_bytes, max_log = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
file_flags = os.O_RDONLY | os.O_NOFOLLOW
root_fd = os.open('/', directory_flags)
try:
    for part in root.strip('/').split('/'):
        next_fd = os.open(part, directory_flags, dir_fd=root_fd)
        os.close(root_fd)
        root_fd = next_fd
    total = 0
    files = []
    def walk(fd, prefix='', depth=0):
        global total
        if depth > 16:
            raise ValueError('OUTPUT_DEPTH_EXCEEDED')
        with os.scandir(fd) as entries:
            names = sorted(entry.name for entry in entries)
        for name in names:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            path = prefix + name
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('OUTPUT_SYMLINK')
            if stat.S_ISDIR(info.st_mode):
                subfd = os.open(name, directory_flags, dir_fd=fd)
                try:
                    walk(subfd, path + '/', depth + 1)
                finally:
                    os.close(subfd)
            elif stat.S_ISREG(info.st_mode):
                if len(files) >= max_files or info.st_size > max_bytes - total:
                    raise ValueError('OUTPUT_LIMIT_EXCEEDED')
                filefd = os.open(name, file_flags, dir_fd=fd)
                with os.fdopen(filefd, 'rb') as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        raise ValueError('OUTPUT_NOT_REGULAR')
                    data = stream.read(max_bytes - total + 1)
                total += len(data)
                if total > max_bytes:
                    raise ValueError('OUTPUT_LIMIT_EXCEEDED')
                files.append({'path': path, 'base64': base64.b64encode(data).decode('ascii')})
            else:
                raise ValueError('OUTPUT_NOT_REGULAR')
    outputs_fd = os.open('outputs', directory_flags, dir_fd=root_fd)
    try:
        walk(outputs_fd)
    finally:
        os.close(outputs_fd)
    def read_log(name):
        try:
            fd = os.open(name, file_flags, dir_fd=root_fd)
        except FileNotFoundError:
            return b'', False
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('LOG_NOT_REGULAR')
            data = stream.read(max_log + 1)
        return data[:max_log], len(data) > max_log
    stdout, out_truncated = read_log('stdout.log')
    stderr, err_truncated = read_log('stderr.log')
    metadata, meta_truncated = read_log('logs.json')
    try:
        logs = json.loads(metadata.decode('utf8')) if metadata and not meta_truncated else {}
    except (ValueError, UnicodeError):
        logs = {}
    print(json.dumps({'outputs': files,
        'stdoutBase64': base64.b64encode(stdout).decode('ascii'),
        'stderrBase64': base64.b64encode(stderr).decode('ascii'),
        'logsTruncated': out_truncated or err_truncated or meta_truncated or bool(logs.get('truncated', False))}))
finally:
    os.close(root_fd)
`;
