"use strict";

// Terminal page tmux WebSocket client.

/* ---------- Terminal ---------- */
const terminalMetaEl = document.getElementById("terminalMeta");
const terminalSessionMetaEl = document.getElementById("terminalSessionMeta");
const terminalPageEl = document.getElementById("pageTerminal");
const terminalScreenEl = document.getElementById("terminalScreen");
const terminalOutputEl = document.getElementById("terminalOutput");
const terminalKeysEl = document.getElementById("terminalKeys");
const btnTerminalCtrlCEl = document.getElementById("btnTerminalCtrlC");
const btnTerminalClearEl = document.getElementById("btnTerminalClear");
const btnTerminalReconnectEl = document.getElementById("btnTerminalReconnect");
const terminalXtermEl = document.getElementById("terminalXterm");

let terminalWs = null;
let terminalReconnectTimer = null;
let terminalPageActive = false;
let terminalSessionName = "";
let terminalLastScreen = "";
let terminalPtyBuffer = "";
let terminalLayoutBound = false;
let terminalFollowOutput = true;
let terminalCurrentCwd = "/data/openpilot";
let terminalScrollRaf = 0;
const terminalUsePty = true;

// Real terminal emulation via xterm.js (grid renderer): interprets cursor
// moves / clears / colors / alternate-screen, so full-screen TUIs (btop, vim,
// nested tmux) render correctly instead of the naive append-only fallback.
// Falls back to the legacy <pre> renderer if xterm.js failed to load.
let terminalXterm = null;
let terminalXtermFit = null;
let terminalXtermActive = false;
let terminalXtermResizeObserver = null;
let terminalXtermFitRaf = 0;
let terminalCtrlSticky = false;
let terminalLayoutRaf = 0;
let terminalKeyboardStateTimer = 0;
let terminalKeysTouchStart = null;
let terminalTouchStart = null;

// Raw escape sequences for the on-screen key bar (Esc/Tab/arrows) so touch
// devices that have no physical Esc/Ctrl/arrow keys can still drive
// interactive programs (vim, btop, less) that the shell input box cannot.
const TERMINAL_KEY_SEQ = {
  esc: "\x1b",
  tab: "\t",
  ctrl_c: "\x03",
  ctrl_d: "\x04",
  home: "\x1b[H",
  end: "\x1b[F",
  page_up: "\x1b[5~",
  page_down: "\x1b[6~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

const terminalTextDecoder = (typeof TextDecoder === "function") ? new TextDecoder("utf-8") : null;

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function readCssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

function terminalXtermSupported() {
  return !!(terminalXtermEl
    && typeof window.Terminal === "function"
    && window.FitAddon
    && typeof window.FitAddon.FitAddon === "function");
}

function terminalUsesTouchKeyboard() {
  if (typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) return true;
    } catch (e) {}
  }
  return (window.innerWidth || 0) <= 640;
}

function setTerminalKeyboardActive(active) {
  if (terminalKeyboardStateTimer) {
    clearTimeout(terminalKeyboardStateTimer);
    terminalKeyboardStateTimer = 0;
  }
  const root = document.documentElement;
  if (active && terminalPageActive && terminalUsesTouchKeyboard()) {
    root.dataset.terminalKeyboardActive = "1";
  } else {
    delete root.dataset.terminalKeyboardActive;
  }
  if (typeof updateAppViewportMetrics === "function") updateAppViewportMetrics();
}

function scheduleTerminalKeyboardInactive(delay = 700) {
  if (terminalKeyboardStateTimer) clearTimeout(terminalKeyboardStateTimer);
  terminalKeyboardStateTimer = window.setTimeout(() => {
    terminalKeyboardStateTimer = 0;
    if (document.documentElement.dataset.kbOpen !== "1") {
      setTerminalKeyboardActive(false);
    }
  }, delay);
}

function setTerminalActiveRoot(active) {
  const root = document.documentElement;
  if (active) root.dataset.terminalActive = "1";
  else delete root.dataset.terminalActive;
}

function getTerminalTouchRegion(target) {
  if (!target?.closest) return null;
  if (target.closest(".terminal-keys")) return "keys";
  if (target.closest(".terminal-xterm")) return "xterm";
  if (target.closest(".terminal-screen")) return "screen";
  return null;
}

function scrollTerminalTouchRegion(region, dy) {
  if (region === "xterm") {
    const viewport = terminalXtermEl?.querySelector?.(".xterm-viewport");
    if (viewport) viewport.scrollTop += dy;
    return true;
  }
  if (region === "screen" && terminalScreenEl) {
    terminalScreenEl.scrollTop += dy;
    return true;
  }
  return false;
}

function bindTerminalTouchContainment() {
  if (!terminalPageEl || terminalPageEl.dataset.touchContainmentBound === "1") return;
  terminalPageEl.dataset.touchContainmentBound = "1";
  terminalPageEl.addEventListener("touchstart", (ev) => {
    const touch = ev.touches && ev.touches[0];
    terminalTouchStart = touch
      ? { x: touch.clientX, y: touch.clientY, lastY: touch.clientY, target: ev.target, region: getTerminalTouchRegion(ev.target) }
      : null;
  }, { passive: true });
  terminalPageEl.addEventListener("touchmove", (ev) => {
    if (!terminalPageActive || !terminalTouchStart) return;
    const touch = ev.touches && ev.touches[0];
    if (!touch) return;
    const dx = touch.clientX - terminalTouchStart.x;
    const dy = touch.clientY - terminalTouchStart.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (terminalTouchStart.region === "keys" && absDx > absDy) return;
    if ((terminalTouchStart.region === "xterm" || terminalTouchStart.region === "screen") && absDy >= absDx) {
      scrollTerminalTouchRegion(terminalTouchStart.region, terminalTouchStart.lastY - touch.clientY);
      terminalTouchStart.lastY = touch.clientY;
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
  }, { passive: false });
  terminalPageEl.addEventListener("touchend", () => {
    terminalTouchStart = null;
  }, { passive: true });
  terminalPageEl.addEventListener("touchcancel", () => {
    terminalTouchStart = null;
  }, { passive: true });
}

// Smaller cell on narrow screens so more columns fit. Terminals wrap at the
// column width (they don't scroll horizontally), so more columns = less
// wrapping / less truncation of wide output on phones.
function terminalFontSize() {
  const w = window.innerWidth || 800;
  if (w <= 380) return 11;
  if (w <= 640) return 12;
  return 13;
}

function ensureTerminalXterm() {
  if (terminalXterm) return terminalXterm;
  if (!terminalXtermSupported()) return null;
  const term = new window.Terminal({
    fontFamily: readCssVar("--font-mono", "ui-monospace, \"Roboto Mono\", Menlo, monospace"),
    fontSize: terminalFontSize(),
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: true,
    allowTransparency: true,
    theme: {
      background: "rgba(0,0,0,0)",
      foreground: readCssVar("--md-on-surface", "#e6e9ef"),
      cursor: readCssVar("--md-primary", "#7ee0a0"),
      cursorAccent: "#0b0f14",
      selectionBackground: "rgba(120,160,255,0.35)",
    },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(terminalXtermEl);
  // Keystrokes typed directly into the grid drive interactive programs.
  term.onData((data) => {
    terminalFollowOutput = true;
    setTerminalKeyboardActive(true);
    sendTerminalPacket({ type: "raw", data: applyTerminalCtrl(data) }, { quiet: true });
  });
  term.onResize(({ cols, rows }) => {
    sendTerminalPacket({ type: "resize", cols, rows }, { quiet: true });
  });
  if (typeof term.onFocus === "function") {
    term.onFocus(() => setTerminalKeyboardActive(true));
  }
  if (typeof term.onBlur === "function") {
    term.onBlur(() => scheduleTerminalKeyboardInactive());
  }
  terminalXterm = term;
  terminalXtermFit = fit;
  // Re-fit whenever the host actually gets/changes size. This fixes the grid
  // opening as a tiny top-left box when the container is not laid out yet at
  // open time (page just shown / reconnect), without relying on fit timing.
  if (typeof ResizeObserver === "function" && !terminalXtermResizeObserver) {
    terminalXtermResizeObserver = new ResizeObserver(() => scheduleTerminalFit());
    terminalXtermResizeObserver.observe(terminalXtermEl);
  }
  return term;
}

function scheduleTerminalFit() {
  if (terminalXtermFitRaf) cancelAnimationFrame(terminalXtermFitRaf);
  terminalXtermFitRaf = requestAnimationFrame(() => {
    terminalXtermFitRaf = 0;
    fitTerminalXterm();
  });
}

function activateTerminalXterm() {
  if (!terminalXtermSupported()) return false;
  // Reveal the grid host before opening so xterm can measure its cell size
  // (a display:none container yields no dimensions).
  if (terminalScreenEl) terminalScreenEl.hidden = true;
  if (terminalXtermEl) terminalXtermEl.hidden = false;
  const term = ensureTerminalXterm();
  if (!term) {
    if (terminalScreenEl) terminalScreenEl.hidden = false;
    if (terminalXtermEl) terminalXtermEl.hidden = true;
    return false;
  }
  terminalXtermActive = true;
  fitTerminalXterm();
  // Container may still be settling right after the page is shown; fit again on
  // the next couple of frames so the grid fills the whole area, not a small box.
  requestAnimationFrame(() => requestAnimationFrame(() => fitTerminalXterm()));
  return true;
}

function fitTerminalXterm() {
  if (!terminalXtermActive || !terminalXtermFit) return;
  try {
    const fs = terminalFontSize();
    if (terminalXterm && terminalXterm.options && terminalXterm.options.fontSize !== fs) {
      terminalXterm.options.fontSize = fs;
    }
    terminalXtermFit.fit();
  } catch (e) {
    /* container not laid out yet */
  }
}

function setTerminalCtrlSticky(on) {
  terminalCtrlSticky = !!on;
  const btn = document.querySelector('.terminal-key[data-key="ctrl"]');
  if (btn) btn.classList.toggle("is-active", terminalCtrlSticky);
}

// When the sticky Ctrl key is armed, fold the next single character into its
// control code (Ctrl-C, Ctrl-D, Ctrl-[, ...), then disarm.
function applyTerminalCtrl(data) {
  if (!terminalCtrlSticky || String(data).length !== 1) return data;
  const code = String(data).toUpperCase().charCodeAt(0);
  setTerminalCtrlSticky(false);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return data;
}

function sendTerminalKey(key) {
  if (key === "ctrl") {
    setTerminalCtrlSticky(!terminalCtrlSticky);
    if (terminalXtermActive && terminalXterm) terminalXterm.focus();
    return;
  }
  const seq = TERMINAL_KEY_SEQ[key];
  if (seq == null) return;
  terminalFollowOutput = true;
  const out = applyTerminalCtrl(seq);
  if (sendTerminalPacket({ type: "raw", data: out }, { quiet: true })) {
    if (terminalXtermActive && terminalXterm) terminalXterm.focus();
  }
}

function currentTerminalSize() {
  if (terminalXtermActive && terminalXtermFit && terminalXtermFit.proposeDimensions) {
    try {
      const dims = terminalXtermFit.proposeDimensions();
      if (dims && dims.cols && dims.rows) {
        return { cols: Math.max(20, dims.cols | 0), rows: Math.max(6, dims.rows | 0) };
      }
    } catch (e) {
      /* fall through to estimate */
    }
  }
  return estimateTerminalSize();
}

function setTerminalMeta(text) {
  if (terminalMetaEl) terminalMetaEl.textContent = String(text || "");
}

function setTerminalSessionMeta(cwd = terminalCurrentCwd) {
  if (!terminalSessionMetaEl) return;
  terminalSessionMetaEl.textContent = String(cwd || "/data/openpilot");
}

function setTerminalSessionInfo(session = terminalSessionName) {
  terminalSessionName = session || terminalSessionName;
  setTerminalSessionMeta();
}

// The web terminal runs `::` meta commands by typing a fixed CLI bridge into
// tmux, so tmux echoes the raw `python3 -m ...cli --line <cmd>` invocation.
// Replace that echo with our own friendly "running command" line.
const TERMINAL_META_ECHO_RE = /(?:env\s+\S*PYTHONPATH=\S+\s+)?python3 -m selfdrive\.carrot\.server\.terminal_commands\.cli --line (.*)$/gm;

function rewriteTerminalMetaEcho(text) {
  return String(text || "").replace(TERMINAL_META_ECHO_RE, (match, raw) => {
    let arg = String(raw || "").trim();
    if (arg.length >= 2 &&
        ((arg[0] === "'" && arg[arg.length - 1] === "'") ||
         (arg[0] === '"' && arg[arg.length - 1] === '"'))) {
      arg = arg.slice(1, -1);
    }
    const label = getUIText("terminal_meta_running", "Carrot command");
    return `> ${label}: ::${arg}`;
  });
}

function sanitizeTerminalScreen(text) {
  let nextText = rewriteTerminalMetaEcho(String(text || " "));
  const headLimit = Math.min(nextText.length, 640);
  const head = nextText.slice(0, headLimit);
  const sanitizedHead = head.replace(
    /[^\n]*\$\s*cd(?:\s+\/data\/openpilot)?\n(?:\/data\/openpilot\n)?(?=[^\n]*:\/data\/openpilot\$)/,
    "",
  );

  if (sanitizedHead !== head) {
    nextText = sanitizedHead + nextText.slice(headLimit);
    nextText = nextText.replace(/^\n+/, "");
  }

  const lines = nextText.replace(/\r/g, "").split("\n");
  while (lines.length > 1 && !lines[lines.length - 1].trim()) {
    lines.pop();
  }
  nextText = lines.join("\n");

  if (!nextText.trim()) return " ";
  return nextText;
}

function stripTerminalAnsi(text) {
  return String(text || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    // Drop leftover C0 control chars (bell, stray ESC, etc.) so they don't
    // render as boxes. Keep \b (0x08), \t (0x09), \n (0x0a), \r (0x0d).
    .replace(/[\x00-\x07\x0b\x0c\x0e-\x1f]/g, "");
}

function appendTerminalPtyOutput(chunk) {
  const text = stripTerminalAnsi(chunk).replace(/\r\n/g, "\n");
  if (!text) return;
  const out = terminalPtyBuffer || "";
  // Split the committed lines from the line currently under the cursor so that
  // carriage-return / backspace overwrite *within* the line the way a real
  // terminal does (e.g. git/pip progress bars), instead of dropping text.
  const lastNl = out.lastIndexOf("\n");
  let head = lastNl >= 0 ? out.slice(0, lastNl + 1) : "";
  let line = lastNl >= 0 ? out.slice(lastNl + 1) : out;
  let col = line.length;
  for (const ch of Array.from(text)) {
    if (ch === "\n") {
      head += line + "\n";
      line = "";
      col = 0;
    } else if (ch === "\r") {
      col = 0;
    } else if (ch === "\b") {
      if (col > 0) col -= 1;
    } else {
      if (col < line.length) {
        line = line.slice(0, col) + ch + line.slice(col + 1);
      } else {
        if (col > line.length) line = line.padEnd(col, " ");
        line += ch;
      }
      col += 1;
    }
  }
  const merged = head + line;
  const lines = merged.split("\n");
  terminalPtyBuffer = lines.length > 600 ? lines.slice(-600).join("\n") : merged;
  setTerminalScreen(terminalPtyBuffer || " ", false);
}

function extractTerminalCwd(text) {
  const lines = String(text || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/^[^\s:@]+@[^\s:]+:(.+?)[#$]\s*$/);
    if (match) return match[1].trim();
  }
  return "";
}

function renderTerminalScreenMarkup(text) {
  return String(text || " ")
    .split("\n")
    .map((line) => {
      const match = line.match(/^([^\s:@]+@[^\s:]+)(?=:[^$]*\$ ?)/);
      if (!match) return escapeHtml(line);
      const promptHost = match[1];
      return `<span class="terminal-output__promptHost">${escapeHtml(promptHost)}</span>${escapeHtml(line.slice(promptHost.length))}`;
    })
    .join("\n");
}

function isTerminalPinnedToBottom() {
  if (!terminalScreenEl) return true;
  return (getTerminalBottomDistance() < 28);
}

function getTerminalBottomDistance() {
  if (!terminalScreenEl) return 0;
  return Math.max(0, terminalScreenEl.scrollHeight - terminalScreenEl.scrollTop - terminalScreenEl.clientHeight);
}

function getTerminalBottomScrollTop() {
  if (!terminalScreenEl) return 0;
  return Math.max(0, terminalScreenEl.scrollHeight - terminalScreenEl.clientHeight);
}

function pinTerminalToBottom(options = {}) {
  if (!terminalScreenEl) return;
  const { immediate = false } = options;
  const apply = () => {
    terminalScreenEl.scrollTop = getTerminalBottomScrollTop();
    updateTerminalOverflowState();
  };
  if (terminalScrollRaf) {
    cancelAnimationFrame(terminalScrollRaf);
    terminalScrollRaf = 0;
  }
  if (immediate) apply();
  terminalScrollRaf = requestAnimationFrame(() => {
    terminalScrollRaf = requestAnimationFrame(() => {
      terminalScrollRaf = 0;
      apply();
    });
  });
}

function updateTerminalOverflowState() {
  if (!terminalScreenEl || !terminalOutputEl) return;
  const overflowX = (terminalOutputEl.scrollWidth - terminalScreenEl.clientWidth) > 20;
  const atRight = (terminalScreenEl.scrollWidth - terminalScreenEl.scrollLeft - terminalScreenEl.clientWidth) < 8;
  terminalScreenEl.classList.toggle("is-x-overflow", overflowX && !atRight);
}

function clearTerminalViewport() {
  terminalLastScreen = "";
  terminalPtyBuffer = "";
  if (terminalOutputEl) terminalOutputEl.innerHTML = "";
  updateTerminalOverflowState();
  pinTerminalToBottom({ immediate: true });
}

function setTerminalScreen(text, forceStick = false) {
  if (!terminalOutputEl) return;
  const nextText = sanitizeTerminalScreen(text);
  if (nextText === terminalLastScreen) return;

  const bottomDistance = getTerminalBottomDistance();
  const previousScrollLeft = terminalScreenEl?.scrollLeft || 0;
  const shouldStick = forceStick || terminalFollowOutput || isTerminalPinnedToBottom();
  terminalLastScreen = nextText;
  const nextCwd = extractTerminalCwd(nextText);
  if (nextCwd && nextCwd !== terminalCurrentCwd) {
    terminalCurrentCwd = nextCwd;
    setTerminalSessionMeta(nextCwd);
  }
  terminalOutputEl.innerHTML = renderTerminalScreenMarkup(nextText);
  requestAnimationFrame(() => {
    updateTerminalOverflowState();
    if (shouldStick) {
      pinTerminalToBottom();
      return;
    }
    if (terminalScreenEl) {
      terminalScreenEl.scrollTop = Math.max(0, terminalScreenEl.scrollHeight - terminalScreenEl.clientHeight - bottomDistance);
      terminalScreenEl.scrollLeft = previousScrollLeft;
    }
  });
}

function clearTerminalReconnectTimer() {
  if (terminalReconnectTimer) {
    clearTimeout(terminalReconnectTimer);
    terminalReconnectTimer = null;
  }
}

function updateTerminalToastAnchor() {
  const anchorEl = terminalKeysEl;
  if (!anchorEl || document.body?.dataset?.page !== "terminal") {
    document.documentElement.style.removeProperty("--terminal-toast-bottom");
    document.documentElement.style.removeProperty("--terminal-toast-left");
    document.documentElement.style.removeProperty("--terminal-toast-width");
    return;
  }

  const rect = anchorEl.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    document.documentElement.style.removeProperty("--terminal-toast-bottom");
    document.documentElement.style.removeProperty("--terminal-toast-left");
    document.documentElement.style.removeProperty("--terminal-toast-width");
    return;
  }
  const gap = 10;
  const vv = window.visualViewport;
  const viewportBottom = vv ? (vv.offsetTop + vv.height) : (window.innerHeight || 0);
  const offset = Math.max(0, Math.round(viewportBottom - rect.top + gap));
  document.documentElement.style.setProperty("--terminal-toast-bottom", `${offset}px`);
  document.documentElement.style.setProperty("--terminal-toast-left", `${Math.round(rect.left)}px`);
  document.documentElement.style.setProperty("--terminal-toast-width", `${Math.round(rect.width)}px`);
}

function updateTerminalViewportMetrics() {
  updateAppViewportMetrics();
}

function bindTerminalLayoutObservers() {
  if (terminalLayoutBound) return;
  terminalLayoutBound = true;

  const handleLayout = (options = {}) => {
    const { resizeTerminal = true } = options;
    if (terminalLayoutRaf) cancelAnimationFrame(terminalLayoutRaf);
    terminalLayoutRaf = requestAnimationFrame(() => {
      terminalLayoutRaf = 0;
      updateTerminalViewportMetrics();
      updateTerminalToastAnchor();
      updateTerminalOverflowState();
      if (resizeTerminal) sendTerminalResize();
      if (!terminalXtermActive && terminalFollowOutput) pinTerminalToBottom();
    });
  };
  const handleResizeLayout = () => handleLayout({ resizeTerminal: true });
  const handleViewportScroll = () => {
    if (document.body?.dataset?.page === "terminal" &&
        (document.documentElement.dataset.kbOpen === "1" ||
         document.documentElement.dataset.terminalKeyboardActive === "1")) {
      updateTerminalToastAnchor();
      return;
    }
    handleLayout({ resizeTerminal: false });
  };

  handleResizeLayout();
  window.addEventListener("resize", handleResizeLayout, { passive: true });
  window.addEventListener("orientationchange", handleResizeLayout, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleResizeLayout, { passive: true });
    window.visualViewport.addEventListener("scroll", handleViewportScroll, { passive: true });
  }
  // VK API mode: the keyboard show/hide fires geometrychange, not a
  // visualViewport resize (the visual viewport no longer moves).
  if (navigator.virtualKeyboard) {
    navigator.virtualKeyboard.addEventListener("geometrychange", handleResizeLayout, { passive: true });
  }
  document.addEventListener("focusout", () => {
    if (document.body?.dataset?.page === "terminal") scheduleTerminalKeyboardInactive();
  }, { passive: true });
}

function refreshTerminalLayout() {
  requestAnimationFrame(() => {
    updateTerminalViewportMetrics();
    updateTerminalToastAnchor();
    updateTerminalOverflowState();
    sendTerminalResize();
    if (!terminalXtermActive && terminalFollowOutput) pinTerminalToBottom();
  });
}

function closeTerminalSocket() {
  if (!terminalWs) return;
  const ws = terminalWs;
  terminalWs = null;
  try {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  } catch (e) {
    console.log("[Terminal] ws close failed:", e);
  }
}

function getTerminalWsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const size = currentTerminalSize();
  const path = terminalUsePty ? "/ws/terminal_pty" : "/ws/terminal";
  const params = new URLSearchParams({
    cols: String(size.cols),
    rows: String(size.rows),
  });
  if (terminalSessionName) params.set("session", terminalSessionName);
  return `${proto}://${location.host}${path}?${params.toString()}`;
}

function estimateTerminalSize() {
  const rect = terminalScreenEl?.getBoundingClientRect?.();
  const style = terminalOutputEl ? getComputedStyle(terminalOutputEl) : null;
  const fontSize = Number.parseFloat(style?.fontSize || "13") || 13;
  const lineHeight = Number.parseFloat(style?.lineHeight || "") || (fontSize * 1.45);
  const charWidth = Math.max(6, fontSize * 0.62);
  return {
    cols: Math.max(40, Math.floor(((rect?.width || 800) - 24) / charWidth)),
    rows: Math.max(12, Math.floor(((rect?.height || 420) - 12) / lineHeight)),
  };
}

function sendTerminalResize() {
  // fit() emits onResize (which sends) when the geometry actually changes;
  // the explicit send below also covers the first, unchanged measurement.
  if (terminalXtermActive) fitTerminalXterm();
  if (!terminalUsePty || !terminalWs || terminalWs.readyState !== WebSocket.OPEN) return;
  sendTerminalPacket({ type: "resize", ...currentTerminalSize() }, { quiet: true });
}

function scheduleTerminalReconnect(delay = 1200) {
  clearTerminalReconnectTimer();
  if (!terminalPageActive) return;
  setTerminalMeta(getUIText("reconnecting", "reconnecting..."));
  terminalReconnectTimer = window.setTimeout(() => {
    terminalReconnectTimer = null;
    connectTerminal();
  }, delay);
}

function sendTerminalPacket(payload, options = {}) {
  const { quiet = false } = options;
  if (!terminalWs || terminalWs.readyState !== WebSocket.OPEN) {
    if (!quiet) showAppToast(getUIText("terminal_offline", "terminal offline"), { tone: "error" });
    return false;
  }

  try {
    terminalWs.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    if (!quiet) showAppToast(e.message || "Terminal send failed", { tone: "error" });
    return false;
  }
}

function sendTerminalControl(action, options = {}) {
  return sendTerminalPacket({ type: "control", action }, options);
}

function connectTerminal(force = false) {
  clearTerminalReconnectTimer();

  if (terminalWs && (terminalWs.readyState === WebSocket.OPEN || terminalWs.readyState === WebSocket.CONNECTING)) {
    if (!force) return;
    closeTerminalSocket();
  }

  setTerminalMeta(getUIText("connecting", "connecting..."));
  if (terminalXtermActive && terminalXterm) terminalXterm.reset();
  else if (terminalUsePty) clearTerminalViewport();

  let ws;
  try {
    ws = new WebSocket(getTerminalWsUrl());
  } catch (e) {
    setTerminalMeta(e.message || getUIText("terminal_unavailable", "terminal unavailable"));
    scheduleTerminalReconnect(1600);
    return;
  }

  terminalWs = ws;

  ws.onopen = () => {
    if (terminalWs !== ws) return;
    setTerminalMeta(getUIText("connecting", "connecting..."));
  };

  ws.onmessage = (ev) => {
    if (terminalWs !== ws) return;

    let data;
    try {
      data = JSON.parse(ev.data);
    } catch (e) {
      return;
    }

    if (data.type === "meta") {
      setTerminalSessionInfo(data.session || terminalSessionName);
      setTerminalMeta(data.mode === "pty"
        ? getUIText("connected", "connected")
        : (data.created ? getUIText("terminal_ready", "tmux ready") : getUIText("connected", "connected")));
      if (terminalXtermActive && terminalXterm) {
        fitTerminalXterm();
        terminalXterm.focus();
      }
      sendTerminalResize();
      return;
    }

    if (data.type === "pty_output") {
      const bytes = data.b64 != null ? base64ToBytes(data.b64) : null;
      if (terminalXtermActive && terminalXterm) {
        terminalXterm.write(bytes || data.text || "");
      } else {
        const text = bytes
          ? (terminalTextDecoder ? terminalTextDecoder.decode(bytes) : data.text || "")
          : (data.text || "");
        appendTerminalPtyOutput(text);
      }
      if (terminalMetaEl && terminalMetaEl.textContent === getUIText("connecting", "connecting...")) {
        setTerminalMeta(getUIText("connected", "connected"));
      }
      return;
    }

    if (data.type === "screen") {
      setTerminalScreen(data.text, false);
      if (terminalMetaEl && terminalMetaEl.textContent === getUIText("connecting", "connecting...")) {
        setTerminalMeta(getUIText("connected", "connected"));
      }
      return;
    }

    if (data.type === "error") {
      const errorText = String(data.error || getUIText("error", "Error"));
      setTerminalMeta(errorText);
      showAppToast(errorText, { tone: "error" });
    }
  };

  ws.onclose = () => {
    if (terminalWs !== ws) return;
    terminalWs = null;
    if (!terminalPageActive) return;
    setTerminalMeta(getUIText("terminal_disconnected", "disconnected"));
    scheduleTerminalReconnect(1250);
  };

  ws.onerror = () => {
    if (terminalWs !== ws) return;
    setTerminalMeta(getUIText("terminal_unavailable", "terminal unavailable"));
  };
}

function initTerminalBindings() {
  const bindNodeOnce = (node, key, fn, eventName = "click") => {
    if (!node || node.dataset[key] === "1") return;
    node.dataset[key] = "1";
    node.addEventListener(eventName, fn);
  };

  bindTerminalLayoutObservers();
  bindTerminalTouchContainment();

  bindNodeOnce(terminalScreenEl, "scrollBound", () => {
    terminalFollowOutput = isTerminalPinnedToBottom();
    updateTerminalOverflowState();
  }, "scroll");

  bindNodeOnce(btnTerminalCtrlCEl, "clickBound", () => {
    terminalFollowOutput = isTerminalPinnedToBottom();
    sendTerminalControl("ctrl_c");
  });

  bindNodeOnce(btnTerminalClearEl, "clickBound", () => {
    terminalFollowOutput = true;
    if (terminalXtermActive && terminalXterm) terminalXterm.clear();
    else clearTerminalViewport();
    sendTerminalControl("clear");
  });

  bindNodeOnce(btnTerminalReconnectEl, "clickBound", () => {
    terminalFollowOutput = isTerminalPinnedToBottom();
    connectTerminal(true);
  });

  // On-screen key bar (Esc/Ctrl/Tab/arrows) for touch devices. mousedown
  // preventDefault keeps focus on the grid so physical/virtual typing that
  // follows still lands in the terminal.
  if (terminalKeysEl && terminalKeysEl.dataset.keysBound !== "1") {
    terminalKeysEl.dataset.keysBound = "1";
    terminalKeysEl.addEventListener("touchstart", (ev) => {
      const touch = ev.touches && ev.touches[0];
      terminalKeysTouchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
      setTerminalKeyboardActive(true);
    }, { passive: true });
    terminalKeysEl.addEventListener("touchmove", (ev) => {
      if (!terminalKeysTouchStart) return;
      const touch = ev.touches && ev.touches[0];
      if (!touch) return;
      const dx = Math.abs(touch.clientX - terminalKeysTouchStart.x);
      const dy = Math.abs(touch.clientY - terminalKeysTouchStart.y);
      if (dy > dx + 4) ev.preventDefault();
    }, { passive: false });
    terminalKeysEl.addEventListener("touchend", () => {
      terminalKeysTouchStart = null;
    }, { passive: true });
    terminalKeysEl.addEventListener("touchcancel", () => {
      terminalKeysTouchStart = null;
    }, { passive: true });
    terminalKeysEl.querySelectorAll(".terminal-key").forEach((btn) => {
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("touchstart", () => setTerminalKeyboardActive(true), { passive: true });
      btn.addEventListener("click", () => {
        setTerminalKeyboardActive(true);
        sendTerminalKey(btn.dataset.key);
      });
    });
  }

  // Click anywhere on the grid host focuses the terminal so a physical (PC)
  // keyboard drives it directly. Esc/Ctrl/arrows are handled natively by xterm.
  if (terminalXtermEl && terminalXtermEl.dataset.focusBound !== "1") {
    terminalXtermEl.dataset.focusBound = "1";
    terminalXtermEl.addEventListener("mousedown", () => {
      setTerminalKeyboardActive(true);
      if (terminalXtermActive && terminalXterm) {
        requestAnimationFrame(() => terminalXterm.focus());
      }
    });
    terminalXtermEl.addEventListener("touchstart", () => setTerminalKeyboardActive(true), { passive: true });
  }
}

function initTerminalPage() {
  terminalPageActive = true;
  setTerminalActiveRoot(true);
  terminalFollowOutput = true;
  terminalCurrentCwd = "/data/openpilot";
  initTerminalBindings();
  activateTerminalXterm();
  setTerminalSessionMeta();
  if (!terminalXtermActive && !terminalLastScreen) setTerminalScreen(" ", true);
  refreshTerminalLayout();
  window.setTimeout(refreshTerminalLayout, 90);
  connectTerminal(false);
  window.CarrotSupportTerminal?.init?.();
}

function teardownTerminalPage() {
  terminalPageActive = false;
  setTerminalActiveRoot(false);
  window.CarrotSupportTerminal?.teardown?.();
  clearTerminalReconnectTimer();
  closeTerminalSocket();
  if (terminalLayoutRaf) {
    cancelAnimationFrame(terminalLayoutRaf);
    terminalLayoutRaf = 0;
  }
  document.documentElement.style.removeProperty("--terminal-toast-bottom");
  document.documentElement.style.removeProperty("--terminal-toast-left");
  document.documentElement.style.removeProperty("--terminal-toast-width");
  setTerminalKeyboardActive(false);
  terminalTouchStart = null;
  terminalKeysTouchStart = null;
}
