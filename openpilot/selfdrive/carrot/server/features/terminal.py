import asyncio
import json
import os
import re
import signal
import struct
import subprocess
from typing import Optional

from aiohttp import web, WSMsgType

from ..config import TMUX_WEB_SESSION
from ..services import tmux
from ..terminal_commands import translate_meta_command

try:
  import fcntl
  import pty
  import termios
except Exception:
  fcntl = None
  pty = None
  termios = None


TMUX_ATTACH_RE = re.compile(r"^\s*tmux\s+(?:a|attach|attach-session)(?:\s*)$", re.IGNORECASE)
TMUX_ATTACH_TARGET_RE = re.compile(r"^\s*tmux\s+(?:a|attach|attach-session)\s+-t\s+\S+\s*$", re.IGNORECASE)


def _translate_terminal_line(line: str) -> str:
  translated = translate_meta_command(line)
  if translated:
    return translated
  text = str(line or "")
  if TMUX_ATTACH_RE.match(text):
    return "TMUX= tmux a -t comma"
  if TMUX_ATTACH_TARGET_RE.match(text):
    return f"TMUX= {text.strip()}"
  return text


def _set_pty_size(fd: int, rows: int, cols: int) -> None:
  if fcntl is None or termios is None:
    return
  rows = max(8, min(int(rows or 24), 200))
  cols = max(20, min(int(cols or 80), 400))
  fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


async def ws_terminal(request: web.Request) -> web.WebSocketResponse:
  ws = web.WebSocketResponse(heartbeat=20, compress=False)
  await ws.prepare(request)

  session = (request.query.get("session") or TMUX_WEB_SESSION).strip() or TMUX_WEB_SESSION
  last_screen = None

  try:
    created = await asyncio.to_thread(tmux.ensure_session, session)
    await ws.send_str(json.dumps({
      "type": "meta",
      "session": session,
      "created": created,
      "user": "comma",
    }))
  except Exception as e:
    await ws.send_str(json.dumps({
      "type": "error",
      "error": str(e),
      "session": session,
    }))
    await ws.close()
    return ws

  async def push_screen(force: bool = False, delay: float = 0.0) -> None:
    nonlocal last_screen
    if delay > 0:
      await asyncio.sleep(delay)
    screen = await asyncio.to_thread(tmux.capture, session)
    if force or screen != last_screen:
      last_screen = screen
      await ws.send_str(json.dumps({
        "type": "screen",
        "session": session,
        "text": screen,
      }))

  async def pump_screen():
    while not ws.closed:
      try:
        await push_screen(force=False)
      except asyncio.CancelledError:
        raise
      except Exception as e:
        await ws.send_str(json.dumps({
          "type": "error",
          "error": str(e),
          "session": session,
        }))
        break
      await asyncio.sleep(0.18)

  pump_task = asyncio.create_task(pump_screen())

  try:
    await push_screen(force=True, delay=0.02)
    async for msg in ws:
      if msg.type == WSMsgType.TEXT:
        try:
          data = json.loads(msg.data)
        except Exception:
          continue

        typ = data.get("type")
        try:
          if typ == "input":
            line = str(data.get("data") or "")
            await asyncio.to_thread(tmux.send_line, session, _translate_terminal_line(line))
            await push_screen(force=True, delay=0.03)
          elif typ == "control":
            action = (data.get("action") or "").strip()
            if action == "ctrl_c":
              await asyncio.to_thread(tmux.ctrl_c, session)
              await push_screen(force=True, delay=0.03)
            elif action == "clear":
              await asyncio.to_thread(tmux.clear, session)
              await push_screen(force=True, delay=0.05)
            elif action == "refresh":
              await push_screen(force=True)
            elif action == "new_session":
              created = await asyncio.to_thread(tmux.ensure_session, session)
              await ws.send_str(json.dumps({
                "type": "meta",
                "session": session,
                "created": created,
                "user": "comma",
              }))
              await push_screen(force=True, delay=0.08)
        except Exception as e:
          await ws.send_str(json.dumps({
            "type": "error",
            "error": str(e),
            "session": session,
          }))
      elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE, WSMsgType.CLOSING):
        break
  finally:
    pump_task.cancel()
    try:
      await pump_task
    except Exception:
      pass
    try:
      await ws.close()
    except Exception:
      pass
  return ws


async def ws_terminal_pty(request: web.Request) -> web.WebSocketResponse:
  ws = web.WebSocketResponse(heartbeat=20, compress=False)
  await ws.prepare(request)

  session = (request.query.get("session") or TMUX_WEB_SESSION).strip() or TMUX_WEB_SESSION
  rows = int(request.query.get("rows") or 28)
  cols = int(request.query.get("cols") or 100)
  master_fd = -1
  slave_fd = -1
  proc: Optional[subprocess.Popen] = None
  reader_task: asyncio.Task | None = None

  try:
    if pty is None:
      raise RuntimeError("PTY terminal is only available on POSIX devices")
    created = await asyncio.to_thread(tmux.ensure_session, session)
    master_fd, slave_fd = pty.openpty()
    _set_pty_size(master_fd, rows, cols)
    env = os.environ.copy()
    env.pop("TMUX", None)
    proc = subprocess.Popen(
      ["tmux", "attach-session", "-t", session],
      stdin=slave_fd,
      stdout=slave_fd,
      stderr=slave_fd,
      close_fds=True,
      env=env,
      start_new_session=True,
    )
    os.close(slave_fd)
    slave_fd = -1
    await ws.send_str(json.dumps({
      "type": "meta",
      "mode": "pty",
      "session": session,
      "created": created,
      "user": "comma",
    }))
  except Exception as e:
    for fd in (master_fd, slave_fd):
      if fd >= 0:
        try:
          os.close(fd)
        except Exception:
          pass
    await ws.send_str(json.dumps({
      "type": "error",
      "error": str(e),
      "session": session,
    }))
    await ws.close()
    return ws

  async def read_pty() -> None:
    assert master_fd >= 0
    while not ws.closed:
      try:
        chunk = await asyncio.to_thread(os.read, master_fd, 4096)
      except OSError:
        break
      if not chunk:
        break
      await ws.send_str(json.dumps({
        "type": "pty_output",
        "session": session,
        "text": chunk.decode("utf-8", errors="replace"),
      }))

  reader_task = asyncio.create_task(read_pty())

  try:
    async for msg in ws:
      if msg.type == WSMsgType.TEXT:
        try:
          data = json.loads(msg.data)
        except Exception:
          continue
        typ = data.get("type")
        try:
          if typ == "input":
            line = _translate_terminal_line(str(data.get("data") or ""))
            os.write(master_fd, (line + "\r").encode("utf-8", errors="replace"))
          elif typ == "raw":
            text = str(data.get("data") or "")
            if text:
              os.write(master_fd, text.encode("utf-8", errors="replace"))
          elif typ == "resize":
            _set_pty_size(master_fd, int(data.get("rows") or rows), int(data.get("cols") or cols))
            if proc and proc.poll() is None:
              try:
                os.killpg(proc.pid, signal.SIGWINCH)
              except Exception:
                pass
          elif typ == "control":
            action = (data.get("action") or "").strip()
            if action == "ctrl_c":
              os.write(master_fd, b"\x03")
            elif action == "clear":
              os.write(master_fd, b"clear\r")
            elif action == "refresh":
              os.write(master_fd, b"\x0c")
            elif action == "detach":
              os.write(master_fd, b"\x02d")
        except Exception as e:
          await ws.send_str(json.dumps({
            "type": "error",
            "error": str(e),
            "session": session,
          }))
      elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE, WSMsgType.CLOSING):
        break
  finally:
    if reader_task:
      reader_task.cancel()
    if proc and proc.poll() is None:
      try:
        os.killpg(proc.pid, signal.SIGHUP)
      except Exception:
        proc.terminate()
    if master_fd >= 0:
      try:
        os.close(master_fd)
      except Exception:
        pass
    if slave_fd >= 0:
      try:
        os.close(slave_fd)
      except Exception:
        pass
    try:
      await ws.close()
    except Exception:
      pass
  return ws


async def handle_download_tmux(request: web.Request) -> web.Response:
  path = "/data/media/tmux.log"
  if not os.path.exists(path):
    return web.json_response({"ok": False, "error": "file not found"}, status=404)

  return web.FileResponse(
    path,
    headers={
      "Content-Disposition": "attachment; filename=tmux.log"
    }
  )


def register(app: web.Application) -> None:
  app.router.add_get("/ws/terminal", ws_terminal)
  app.router.add_get("/ws/terminal_pty", ws_terminal_pty)
  app.router.add_get("/download/tmux.log", handle_download_tmux)
