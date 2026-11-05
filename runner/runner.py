"""Runs inside a disposable, network-disabled container with no platform secrets."""
import asyncio
import glob
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def command(args, timeout=100, **kwargs):
    result = subprocess.run(args, timeout=timeout, **kwargs)
    if result.returncode:
        raise SystemExit(result.returncode)


def project():
    target = Path("/tmp/project")
    shutil.copytree("/input", target)
    return target


def maven(target, *goals):
    command(["mvn", "-B", "--no-transfer-progress", "-o", "-Dmaven.repo.local=/opt/m2",
             "-Dmaven.ext.class.path=", *goals], cwd=target,
            env={**os.environ, "MAVEN_OPTS": "-Xmx128m -XX:MaxMetaspaceSize=128m"})


def check():
    target = project()
    maven(target, "test")
    trusted = Path("/tmp/trusted")
    trusted.mkdir()
    junit = "/opt/junit-console.jar"
    files = list(Path("/opt/acceptance").rglob("*.java"))
    # The platform's trusted test source is outside the upload and is compiled afresh.
    command(["javac", "-J-Xmx96m", "-encoding", "UTF-8", "-cp", str(target / "target/classes") + ":" + junit,
             "-d", str(trusted), *map(str, files)], timeout=35)
    command(["java", "-Xmx128m", "-Djava.awt.headless=true", "-jar", junit, "execute", "--disable-banner",
             "--class-path", str(trusted) + ":" + str(target / "target/classes"), "--scan-class-path", "--fail-if-no-tests"], timeout=40)
    print("XIANGQI_TRUSTED_ACCEPTANCE_PASSED", flush=True)


async def bridge(reader, writer):
    target_reader, target_writer = await asyncio.open_connection("127.0.0.1", 5900)
    async def pipe(source, destination):
        try:
            while chunk := await source.read(65536):
                destination.write(chunk)
                await destination.drain()
        finally:
            destination.close()
    await asyncio.gather(pipe(reader, target_writer), pipe(target_reader, writer), return_exceptions=True)


async def desktop():
    target = project()
    maven(target, "compile")
    env = {**os.environ, "DISPLAY": ":1", "XIANGQI_DATA_DIR": "/data"}
    # Capture a resizable portion of a large root display, so dialogs remain visible.
    xvfb = subprocess.Popen(["Xvfb", ":1", "-screen", "0", "4096x3072x24", "-nolisten", "tcp"])
    for _ in range(50):
        if Path("/tmp/.X11-unix/X1").exists():
            break
        await asyncio.sleep(.1)
    viewport = Path('/sockets/viewport')
    if not viewport.exists(): viewport.write_text('1000 760')
    size = tuple(map(int, viewport.read_text().split()))
    vnc = subprocess.Popen(["x11vnc", "-display", ":1", "-clip", f"{size[0]}x{size[1]}+0+0", "-rfbport", "5900", "-localhost", "-forever", "-shared", "-nopw", "-quiet"], env=env)
    entry = "Main" if (target / "target/classes/Main.class").exists() else "edu.sustech.xiangqi.Main"
    java = subprocess.Popen(["java", "-Xmx128m", "-cp", str(target / "target/classes") + ":/opt/runner", "StudioLauncher", entry], env=env)
    socket = Path("/sockets/vnc.sock")
    socket.unlink(missing_ok=True)
    server = await asyncio.start_unix_server(bridge, path=str(socket))
    socket.chmod(0o600)
    print("XIANGQI_GUI_READY", flush=True)
    try:
        async with server:
            while java.poll() is None and xvfb.poll() is None and vnc.poll() is None:
                requested = tuple(map(int, viewport.read_text().split()))
                if requested != size:
                    size = requested
                    subprocess.run(["x11vnc", "-display", ":1", "-R", f"clip:{size[0]}x{size[1]}+0+0"],
                                   timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
                await asyncio.sleep(.3)
    finally:
        socket.unlink(missing_ok=True)
        for process in (java, vnc, xvfb):
            if process.poll() is None:
                process.terminate()


def lsp():
    home = Path("/home/runner")
    settings = home / ".m2"
    settings.mkdir(exist_ok=True)
    repository = Path("/language/m2")
    if not repository.exists():
        shutil.copytree("/opt/m2", repository)
    (settings / "settings.xml").write_text("<settings><localRepository>/language/m2</localRepository><offline>true</offline></settings>")
    config = Path("/language/config")
    if not config.exists():
        shutil.copytree("/opt/jdtls/config_linux", config)
    launcher = glob.glob("/opt/jdtls/plugins/org.eclipse.equinox.launcher_*.jar")[0]
    args = ["java", "-Xmx256m", "-XX:MaxMetaspaceSize=160m", "-Duser.home=/home/runner", "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Dlog.level=ERROR",
            "-Dmaven.repo.local=/language/m2", "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED",
            "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", launcher,
            "-configuration", str(config), "-data", "/language/workspace"]
    os.execvp(args[0], args)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "check": check()
    elif mode == "run": asyncio.run(desktop())
    elif mode == "lsp": lsp()
    else: raise SystemExit("Unknown runner mode")
