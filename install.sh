#!/usr/bin/env bash
#
# install.sh — set up opencode-llamacpp-discover for a local llama-server.
#
# What it does:
#   1. Checks that OpenCode v2 is installed (this plugin does not run on v1).
#   2. Finds the running llama-server by reading its command line and by probing
#      likely ports. A port only counts if /props returns llama.cpp JSON, so an
#      unrelated server on 8080 is not mistaken for llama-server.
#   3. Normalizes the result to an OpenAI-compatible base URL (…/v1).
#   4. Adds/updates the `plugins` entry in opencode.jsonc, preserving every
#      other setting and comment in the file (only the `plugins` array itself is
#      re-serialized). A timestamped backup is written first.
#   5. Restarts the OpenCode service and prints how to verify.
#
# Usage:
#   ./install.sh                     # detect, install, restart
#   ./install.sh --url http://127.0.0.1:8090/v1
#   ./install.sh --dry-run           # detect and show the config change only
#   ./install.sh --doctor            # diagnostics only, no changes
#   ./install.sh --yes --no-restart  # unattended, leave the service alone
#
# Options:
#   --url URL          llama-server URL (bare root or …/v1); skips auto-detection
#   --plugin-dir DIR   plugin directory to register (default: this checkout)
#   --config FILE      config file to edit (default: global opencode.jsonc)
#   --provider-id ID   OpenCode provider ID (default: llama)
#   --dry-run          print the change, write nothing, do not restart
#   --doctor           print diagnostics and exit
#   --yes              assume "yes" for prompts (pick first match, restart)
#   --no-restart       do not run `opencode service restart`
#   -h, --help         show this help
#
set -euo pipefail

PLUGIN_DIR_DEFAULT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_DIR="$PLUGIN_DIR_DEFAULT"
PROVIDER_ID="llama"
URL_OVERRIDE=""
CONFIG_OVERRIDE=""
DRY_RUN=0
DOCTOR=0
ASSUME_YES=0
RESTART=1

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
  --url) URL_OVERRIDE="${2:?--url needs a value}"; shift 2 ;;
  --url=*) URL_OVERRIDE="${1#*=}"; shift ;;
  --plugin-dir) PLUGIN_DIR="${2:?--plugin-dir needs a value}"; shift 2 ;;
  --plugin-dir=*) PLUGIN_DIR="${1#*=}"; shift ;;
  --config) CONFIG_OVERRIDE="${2:?--config needs a value}"; shift 2 ;;
  --config=*) CONFIG_OVERRIDE="${1#*=}"; shift ;;
  --provider-id) PROVIDER_ID="${2:?--provider-id needs a value}"; shift 2 ;;
  --provider-id=*) PROVIDER_ID="${1#*=}"; shift ;;
  --dry-run) DRY_RUN=1; RESTART=0; shift ;;
  --doctor) DOCTOR=1; shift ;;
  --yes | -y) ASSUME_YES=1; shift ;;
  --no-restart) RESTART=0; shift ;;
  -h | --help) usage ;;
  *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Platform / config paths
# ---------------------------------------------------------------------------

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
if [ -n "$CONFIG_OVERRIDE" ]; then
  CONFIG_FILE="$CONFIG_OVERRIDE"
elif [ -f "$CONFIG_DIR/opencode.jsonc" ]; then
  CONFIG_FILE="$CONFIG_DIR/opencode.jsonc"
elif [ -f "$CONFIG_DIR/opencode.json" ]; then
  CONFIG_FILE="$CONFIG_DIR/opencode.json"
else
  CONFIG_FILE="$CONFIG_DIR/opencode.jsonc"
fi

is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] && return 0
  [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null
}

# IPv4 address of the Windows host as seen from WSL (empty when unknown).
wsl_host_ip() {
  local ip=""
  if have ip; then
    ip="$(ip route show default 2>/dev/null | awk 'NR==1 {print $3}')"
  fi
  if [ -z "$ip" ] && [ -r /etc/resolv.conf ]; then
    ip="$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null || true)"
  fi
  printf '%s' "$ip"
}

# Listening ports of a Windows-side llama-server (WSL only). Prints nothing when
# PowerShell interop is unavailable.
windows_llama_ports() {
  have powershell.exe || return 0
  powershell.exe -NoProfile -NonInteractive -Command '
    Get-Process llama-server -ErrorAction SilentlyContinue |
      ForEach-Object {
        Get-NetTCPConnection -State Listen -OwningProcess $_.Id -ErrorAction SilentlyContinue
      } |
      Select-Object -ExpandProperty LocalPort -Unique
  ' 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' || true
}

# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------

# Strip trailing slashes and a trailing /v1 → bare server root.
url_root() {
  local u="${1%/}"
  u="${u%/v1}"
  printf '%s' "${u%/}"
}

# Accept either a bare root or …/v1 and always return …/v1.
url_base() {
  printf '%s/v1' "$(url_root "$1")"
}

# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------

PROBE_MODEL=""
PROBE_CTX=""
PROBE_THINKING=""
PROBE_SLEEP=""

json_field_string() { # json key
  printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 |
    sed 's/.*:[[:space:]]*"\(.*\)"$/\1/'
}

json_field_number() { # json key
  printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" | head -n 1 |
    grep -o '[0-9][0-9]*$'
}

# probe_server ROOT
# Succeeds only when ROOT looks like a llama.cpp server:
#   - /props returns a JSON object
#   - /v1/models returns JSON with a `data` array
# Sets PROBE_MODEL / PROBE_CTX / PROBE_THINKING.
probe_server() {
  local root="$1" props models
  have curl || return 1

  props="$(curl -fsS --connect-timeout 1 --max-time 2 "$root/props" 2>/dev/null)" || return 1
  case "$props" in
  \{*) ;;
  *) return 1 ;;
  esac

  models="$(curl -fsS --connect-timeout 1 --max-time 2 "$root/v1/models" 2>/dev/null)" || return 1
  case "$models" in
  *'"data"'*) ;;
  *) return 1 ;;
  esac

  PROBE_MODEL="$(json_field_string "$models" id || true)"
  [ -n "$PROBE_MODEL" ] || PROBE_MODEL="?"
  PROBE_CTX="$(json_field_number "$props" n_ctx || true)"
  PROBE_SLEEP=""
  if printf '%s' "$props" | grep -Eq '"is_sleeping"[[:space:]]*:[[:space:]]*true'; then
    PROBE_SLEEP=" [sleeping]"
  fi
  if printf '%s' "$props" | grep -q '"chat_template"\|"chat_template_caps"'; then
    PROBE_THINKING="chat template present"
  else
    PROBE_THINKING="no chat template"
  fi
  return 0
}

# True when something is listening on host:port (fast pre-check).
tcp_open() {
  local host="$1" port="$2"
  if have timeout && [ -n "${BASH_VERSION:-}" ]; then
    timeout 1 bash -c ": >/dev/tcp/$host/$port" 2>/dev/null && return 0
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

CANDIDATE_ROOTS=()
CANDIDATE_NOTES=()

add_candidate() { # root note
  local root note i
  root="$(url_root "$1")"
  note="${2:-}"
  [ -n "$root" ] || return 0
  for i in "${!CANDIDATE_ROOTS[@]}"; do
    [ "${CANDIDATE_ROOTS[$i]}" = "$root" ] && return 0
  done
  probe_server "$root" || return 1
  CANDIDATE_ROOTS+=("$root")
  CANDIDATE_NOTES+=("$note")
  ok "$(url_base "$root") — model $PROBE_MODEL${PROBE_CTX:+, ctx $PROBE_CTX}${note:+ ($note)}${PROBE_SLEEP}"
  return 0
}

# Ports mentioned on llama-server command lines, plus default/host values.
detect_from_processes() {
  local line port host found=0
  have ps || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    found=1
    port="$(printf '%s\n' "$line" | sed -nE 's/.*--port[= ]+([0-9]+).*/\1/p' | tail -n 1)"
    [ -n "$port" ] || port="8080"
    host="$(printf '%s\n' "$line" | sed -nE 's/.*--host[= ]+([^ ]+).*/\1/p' | tail -n 1)"
    case "$host" in
    "" | 0.0.0.0 | :: | "[::]") host="127.0.0.1" ;;
    ::1) host="[::1]" ;;
    esac

    PROCESS_PORTS+=("$port")
    PROCESS_HOSTS+=("$host")

    if printf '%s' "$line" | grep -q -- '--api-key'; then
      API_KEY_SEEN=1
    fi

    add_candidate "http://$host:$port" "process: llama-server --port $port" || true
  done < <(ps -eo args= 2>/dev/null | grep -F 'llama-server' | grep -v 'grep' | grep -v 'install.sh' || true)

  [ "$found" = 1 ] || info "no llama-server process found on this system"
}

PROCESS_PORTS=()
PROCESS_HOSTS=()
API_KEY_SEEN=0
WIN_PORTS=()

detect_all() {
  local root

  # 1. Explicit URL always wins.
  if [ -n "$URL_OVERRIDE" ]; then
    root="$(url_root "$URL_OVERRIDE")"
    if probe_server "$root"; then
      CANDIDATE_ROOTS+=("$root")
      CANDIDATE_NOTES+=("--url")
      ok "$(url_base "$root") — model $PROBE_MODEL${PROBE_CTX:+, ctx $PROBE_CTX} (--url)${PROBE_SLEEP}"
    else
      die "no llama.cpp server at $root (GET /props and /v1/models failed)"
    fi
    return 0
  fi

  # 2. The server(s) already referenced by the current config.
  local current
  current="$(grep -o '"baseURL"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" 2>/dev/null |
    sed 's/.*"\(http[^"]*\)"$/\1/' | head -n 1 || true)"
  [ -n "$current" ] && add_candidate "$current" "existing config" || true

  # 3. Running llama-server processes.
  bold "Detecting llama-server"
  detect_from_processes

  # 4. WSL: ports of a llama-server.exe on the Windows side.
  if is_wsl; then
    while IFS= read -r port; do
      [ -n "$port" ] || continue
      WIN_PORTS+=("$port")
    done < <(windows_llama_ports)
    if [ ${#WIN_PORTS[@]} -gt 0 ]; then
      info "Windows-side llama-server listens on port(s): ${WIN_PORTS[*]}"
    fi
  fi

  # 5. Port scan on localhost (and the Windows host under WSL).
  local hosts=("127.0.0.1")
  if is_wsl; then
    local wh
    wh="$(wsl_host_ip)"
    if [ -n "$wh" ]; then hosts+=("$wh"); fi
  fi

  local ports=()
  [ ${#PROCESS_PORTS[@]} -gt 0 ] && ports+=("${PROCESS_PORTS[@]}")
  [ ${#WIN_PORTS[@]} -gt 0 ] && ports+=("${WIN_PORTS[@]}")
  ports+=(8080 8081 8090 8000 8001)

  local -A seen=()
  local host port
  for host in "${hosts[@]}"; do
    for port in "${ports[@]}"; do
      [ -n "${seen[$host:$port]:-}" ] && continue
      seen[$host:$port]=1
      tcp_open "$host" "$port" || continue
      add_candidate "http://$host:$port" "port scan" || true
    done
  done

  if [ ${#CANDIDATE_ROOTS[@]} -eq 0 ]; then
    printf '\n' >&2
    warn "no reachable llama-server found"
    if is_wsl; then
      warn "WSL detected. If llama-server runs on Windows, it must listen on all interfaces:"
      info 'llama-server -m model.gguf --host 0.0.0.0 --port 8080'
      info "then allow the port through the Windows firewall and re-run this script."
      [ ${#WIN_PORTS[@]} -gt 0 ] && info "Windows reports a listener on ${WIN_PORTS[*]} but WSL cannot reach it (likely bound to 127.0.0.1)."
    fi
    info "start it first, or pass --url http://HOST:PORT/v1"
    exit 1
  fi
}

choose_candidate() {
  if [ ${#CANDIDATE_ROOTS[@]} -eq 1 ]; then
    CHOSEN_ROOT="${CANDIDATE_ROOTS[0]}"
    return
  fi

  bold "Multiple llama-server instances found"
  local i
  for i in "${!CANDIDATE_ROOTS[@]}"; do
    printf '  %d) %s  (%s)\n' "$((i + 1))" "$(url_base "${CANDIDATE_ROOTS[$i]}")" "${CANDIDATE_NOTES[$i]}"
  done

  if [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; then
    local answer
    read -r -p "Choose [1-${#CANDIDATE_ROOTS[@]}] (default 1): " answer || answer=""
    answer="${answer:-1}"
    if ! [[ "$answer" =~ ^[0-9]+$ ]] || [ "$answer" -lt 1 ] || [ "$answer" -gt ${#CANDIDATE_ROOTS[@]} ]; then
      die "invalid choice: $answer"
    fi
    CHOSEN_ROOT="${CANDIDATE_ROOTS[$((answer - 1))]}"
  else
    warn "picking the first match; use --url to choose another"
    CHOSEN_ROOT="${CANDIDATE_ROOTS[0]}"
  fi
}

# ---------------------------------------------------------------------------
# Config editing (Python, JSONC-aware)
# ---------------------------------------------------------------------------

edit_config() { # base_url
  local base_url="$1"
  have python3 || die "python3 is required to edit $CONFIG_FILE safely (set --config manually otherwise)"

  mkdir -p "$(dirname "$CONFIG_FILE")"

  CONFIG_FILE="$CONFIG_FILE" PLUGIN_DIR="$PLUGIN_DIR" BASE_URL="$base_url" \
    PROVIDER_ID="$PROVIDER_ID" DRY_RUN="$DRY_RUN" python3 - <<'PY'
import json, os, re, shutil, sys, time

path       = os.environ["CONFIG_FILE"]
plugin_dir = os.path.realpath(os.path.expanduser(os.environ["PLUGIN_DIR"]))
base_url   = os.environ["BASE_URL"]
provider   = os.environ["PROVIDER_ID"]
dry        = os.environ["DRY_RUN"] == "1"

# --------------------------------------------------------------------------
# Minimal JSONC → JSON (comments and trailing commas), position-preserving
# is not needed here: we only use this to validate/read values.
# --------------------------------------------------------------------------

def strip_jsonc(s: str) -> str:
    out = []
    i, n = 0, len(s)
    in_str = esc = False
    while i < n:
        c = s[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "/":
            while i < n and s[i] not in "\r\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "*":
            i += 2
            while i + 1 < n and not (s[i] == "*" and s[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1

    # Remove trailing commas before } or ].
    s2 = "".join(out)
    out = []
    i, n = 0, len(s2)
    in_str = esc = False
    while i < n:
        c = s2[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == ",":
            j = i + 1
            while j < n and s2[j] in " \t\r\n":
                j += 1
            if j < n and s2[j] in "}]":
                i += 1
                continue
        out.append(c)
        i += 1
    return "".join(out)

# --------------------------------------------------------------------------
# Position-aware scanning over the ORIGINAL text (comments included)
# --------------------------------------------------------------------------

def skip_ws_comments(s: str, i: int) -> int:
    n = len(s)
    while i < n:
        if s[i] in " \t\r\n":
            i += 1
        elif s[i] == "/" and i + 1 < n and s[i + 1] == "/":
            while i < n and s[i] not in "\r\n":
                i += 1
        elif s[i] == "/" and i + 1 < n and s[i + 1] == "*":
            i += 2
            while i + 1 < n and not (s[i] == "*" and s[i + 1] == "/"):
                i += 1
            i = min(i + 2, n)
        else:
            break
    return i

def read_string(s: str, i: int):
    """Return (value, index_after_closing_quote). i points at the quote."""
    assert s[i] == '"'
    i += 1
    buf = []
    while i < len(s):
        c = s[i]
        if c == "\\":
            buf.append(s[i:i + 2])
            i += 2
            continue
        if c == '"':
            return json.loads('"' + "".join(buf) + '"'), i + 1
        buf.append(c)
        i += 1
    raise ValueError("unterminated string")

def match_bracket(s: str, i: int) -> int:
    open_c = s[i]
    close_c = "}" if open_c == "{" else "]"
    depth = 1
    i += 1
    while i < len(s):
        c = s[i]
        if c == '"':
            _, i = read_string(s, i)
            continue
        if c == "/" and i + 1 < len(s) and s[i + 1] == "/":
            i = skip_ws_comments(s, i)
            continue
        if c == "/" and i + 1 < len(s) and s[i + 1] == "*":
            i = skip_ws_comments(s, i)
            continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError("unbalanced brackets")

def scan_value_end(s: str, i: int) -> int:
    i = skip_ws_comments(s, i)
    if i >= len(s):
        raise ValueError("missing value")
    c = s[i]
    if c in "{[":
        return match_bracket(s, i)
    if c == '"':
        _, end = read_string(s, i)
        return end
    while i < len(s) and s[i] not in ",}]":
        i += 1
    return i

def find_root_open(s: str) -> int:
    return skip_ws_comments(s, 0)

def find_root_close(s: str) -> int:
    i = find_root_open(s)
    if i >= len(s) or s[i] != "{":
        raise ValueError("config root is not a JSON object")
    return match_bracket(s, i) - 1

def find_top_level_member(s: str, key: str):
    """Return (value_start, value_end) for a top-level key, or None."""
    i = find_root_open(s)
    if s[i] != "{":
        raise ValueError("config root is not a JSON object")
    i += 1
    while True:
        i = skip_ws_comments(s, i)
        if i >= len(s) or s[i] == "}":
            return None
        if s[i] == ",":
            i += 1
            continue
        if s[i] != '"':
            raise ValueError(f"unexpected character at offset {i}")
        name, i = read_string(s, i)
        i = skip_ws_comments(s, i)
        if i >= len(s) or s[i] != ":":
            raise ValueError(f"expected ':' after {name!r}")
        i = skip_ws_comments(s, i + 1)
        start = i
        end = scan_value_end(s, i)
        if name == key:
            return start, end
        i = end

def find_last_member_end(s: str):
    """End offset of the last top-level member value (None for an empty object)."""
    i = find_root_open(s)
    if s[i] != "{":
        raise ValueError("config root is not a JSON object")
    i += 1
    last = None
    while True:
        i = skip_ws_comments(s, i)
        if i >= len(s) or s[i] == "}":
            return last
        if s[i] == ",":
            i += 1
            continue
        if s[i] != '"':
            raise ValueError(f"unexpected character at offset {i}")
        _, i = read_string(s, i)
        i = skip_ws_comments(s, i)
        if i >= len(s) or s[i] != ":":
            raise ValueError("expected ':'")
        i = skip_ws_comments(s, i + 1)
        last = scan_value_end(s, i)
        i = last

# --------------------------------------------------------------------------
# Plugin list edit
# --------------------------------------------------------------------------

def looks_like_path(v: str) -> bool:
    return v.startswith(("/", "./", "../", "~"))

def same_plugin(pkg, wanted: str) -> bool:
    if not isinstance(pkg, str) or not looks_like_path(pkg):
        return False
    try:
        return os.path.realpath(os.path.expanduser(pkg)) == wanted
    except OSError:
        return False

def entry_package(e):
    if isinstance(e, str):
        return e
    if isinstance(e, dict):
        return e.get("package")
    return None

def make_entry():
    return {"package": plugin_dir, "options": entry_options({})}

def entry_options(opts):
    opts = dict(opts)
    opts["baseURL"] = base_url
    if provider and provider != "llama":
        opts["providerID"] = provider
    return opts

def normalize_plugins(plugins):
    if not isinstance(plugins, list):
        raise ValueError("top-level 'plugins' is not an array")
    out = []
    found = False
    for e in plugins:
        if same_plugin(entry_package(e), plugin_dir):
            if found:
                continue  # drop duplicates: loading twice breaks the plugin
            found = True
            if isinstance(e, str):
                e = make_entry()
            else:
                opts = e.get("options")
                if not isinstance(opts, dict):
                    opts = {}
                e["options"] = entry_options(opts)
            out.append(e)
        else:
            out.append(e)
    if not found:
        out.append(make_entry())
    return out, found

# --------------------------------------------------------------------------

raw = ""
if os.path.exists(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()

created = False
if raw.strip() == "":
    raw = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
    created = True

try:
    data = json.loads(strip_jsonc(raw))
except Exception as e:
    print(f"error: cannot parse {path}: {e}")
    print("       fix the file by hand or pass --config with another file")
    sys.exit(2)

if not isinstance(data, dict):
    print(f"error: {path} does not contain a JSON object")
    sys.exit(2)

if isinstance(data.get("plugin"), list):
    print("warning: this file uses the V1 'plugin' key; V2 reads 'plugins'.")
    if any(same_plugin(entry_package(e), plugin_dir) for e in data["plugin"]):
        print("         It also lists this plugin — remove that entry to avoid loading it twice.")
    else:
        print("         This script only edits 'plugins'. Keep or remove 'plugin' yourself.")

span = find_top_level_member(raw, "plugins")

if span is None:
    plugins, found = normalize_plugins([])
    rendered = json.dumps(plugins, indent=2, ensure_ascii=False)
    lines = rendered.split("\n")
    rendered = lines[0] + "".join("\n  " + ln for ln in lines[1:])
    root_close = find_root_close(raw)
    last_end = find_last_member_end(raw)
    if last_end is not None:
        new_raw = raw[:last_end] + ',\n  "plugins": ' + rendered + raw[last_end:]
    else:
        new_raw = raw[:root_close] + '\n  "plugins": ' + rendered + "\n" + raw[root_close:]
else:
    start, end = span
    if start >= len(raw) or raw[start] != "[":
        print("error: top-level 'plugins' is not an array")
        sys.exit(2)
    try:
        existing = json.loads(strip_jsonc(raw[start:end]))
    except Exception as e:
        print(f"error: cannot parse the 'plugins' array: {e}")
        sys.exit(2)
    plugins, found = normalize_plugins(existing)
    rendered = json.dumps(plugins, indent=2, ensure_ascii=False)
    line_start = raw.rfind("\n", 0, start) + 1
    key_indent = re.match(r"[ \t]*", raw[line_start:]).group(0)
    pad = key_indent
    lines = rendered.split("\n")
    rendered = lines[0] + "".join("\n" + pad + ln for ln in lines[1:])
    new_raw = raw[:start] + rendered + raw[end:]

try:
    json.loads(strip_jsonc(new_raw))
except Exception as e:
    print(f"error: edited config would be invalid ({e}); nothing written")
    sys.exit(2)

mode = "updated" if span is not None else "added"
if new_raw == raw and not created:
    print("unchanged")
    sys.exit(10)

if dry:
    print(f"would {mode} plugins entry:")
    print(json.dumps(plugins, indent=2, ensure_ascii=False))
    sys.exit(0)

if not created:
    backup = f"{path}.bak.{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)
    print(f"backup: {backup}")

tmp = f"{path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(new_raw)
if os.path.exists(path):
    shutil.copymode(path, tmp)
os.replace(tmp, path)
print(mode)
PY
}

# ---------------------------------------------------------------------------
# Doctor
# ---------------------------------------------------------------------------

doctor() {
  bold "OpenCode"
  if have opencode; then
    local version
    version="$(opencode --version 2>/dev/null || echo "unknown")"
    info "binary: $(command -v opencode)"
    info "version: $version"
    case "$version" in
    *" v0."* | *" v1."*) warn "this plugin requires OpenCode v2 (v1 plugins are not compatible)" ;;
    esac
  else
    warn "opencode not found on PATH"
  fi

  bold "Config"
  info "file: $CONFIG_FILE"
  if [ -f "$CONFIG_FILE" ]; then
    ok "exists"
    if grep -q '"plugins"' "$CONFIG_FILE"; then
      ok "has a top-level 'plugins' array"
    else
      warn "no top-level 'plugins' key (V2 uses 'plugins'; V1 used 'plugin')"
    fi
    if grep -q 'llamacpp-discover' "$CONFIG_FILE"; then
      ok "references llamacpp-discover"
    else
      warn "does not reference llamacpp-discover"
    fi
    if grep -q '"plugin"[[:space:]]*:' "$CONFIG_FILE"; then
      warn "V1-style 'plugin' key present; V2 ignores it"
    fi
  else
    warn "missing (the installer creates it)"
  fi

  bold "llama-server"
  local found=0
  if [ -n "$URL_OVERRIDE" ]; then
    if probe_server "$(url_root "$URL_OVERRIDE")"; then
      ok "$(url_base "$URL_OVERRIDE") — model $PROBE_MODEL${PROBE_CTX:+, ctx $PROBE_CTX}${PROBE_SLEEP}"
      found=1
    else
      warn "nothing answering at $(url_root "$URL_OVERRIDE")"
    fi
  else
    local port root
    for port in 8080 8081 8090 8000 8001; do
      for root in "http://127.0.0.1:$port"; do
        if probe_server "$root"; then
          ok "$(url_base "$root") — model $PROBE_MODEL${PROBE_CTX:+, ctx $PROBE_CTX}${PROBE_SLEEP}"
          found=1
        fi
      done
    done
    if is_wsl; then
      local wh
      wh="$(wsl_host_ip)"
      if [ -n "$wh" ]; then
        for port in 8080 8081 8090; do
          if probe_server "http://$wh:$port"; then
            ok "$(url_base "http://$wh:$port") — model $PROBE_MODEL${PROBE_CTX:+, ctx $PROBE_CTX}${PROBE_SLEEP} (Windows host)"
            found=1
          fi
        done
      fi
      local wp
      wp="$(windows_llama_ports)"
      if [ -n "$wp" ]; then info "Windows-side listeners: $(printf '%s ' $wp)"; fi
    fi
    [ "$found" = 1 ] || warn "no llama.cpp server found on common ports"
  fi

  bold "Environment"
  info "config dir: $CONFIG_DIR"
  if is_wsl; then
    info "WSL: yes (Windows host IP $(wsl_host_ip))"
    info "If llama-server runs on Windows, start it with --host 0.0.0.0 and open the firewall."
  else
    info "WSL: no"
  fi

  bold "Recent plugin log lines"
  local log
  log="$(ls -t "$HOME/.local/share/opencode/log/"*.log 2>/dev/null | head -n 1 || true)"
  if [ -n "$log" ]; then
    info "$log"
    (grep -hF '[llamacpp-discover]' "$log" 2>/dev/null | tail -n 8 || true) | cut -c1-240 | sed 's/^/    /'
    grep -qF '[llamacpp-discover]' "$log" 2>/dev/null || info "no [llamacpp-discover] lines yet — restart the service after installing"
  else
    info "no log file yet"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if [ "$DOCTOR" = 1 ]; then
  doctor
  exit 0
fi

bold "opencode-llamacpp-discover installer"

if ! have opencode; then
  die "opencode is not on PATH. Install OpenCode v2 first: https://opencode.ai/v2/docs/cli"
fi
OPENCODE_VERSION="$(opencode --version 2>/dev/null || echo unknown)"
info "OpenCode: $OPENCODE_VERSION"
case "$OPENCODE_VERSION" in
*" v0."* | *" v1."*)
  die "OpenCode v2 is required; this plugin uses the V2 plugin API (found: $OPENCODE_VERSION)"
  ;;
esac

[ -d "$PLUGIN_DIR" ] || die "plugin directory not found: $PLUGIN_DIR"
[ -f "$PLUGIN_DIR/src/index.ts" ] || die "$PLUGIN_DIR does not look like this plugin (src/index.ts missing)"
PLUGIN_DIR="$(cd "$PLUGIN_DIR" && pwd -P)"

bold "Config"
info "$CONFIG_FILE"

detect_all
choose_candidate
BASE_URL="$(url_base "$CHOSEN_ROOT")"

bold "Installing"
info "plugin:  $PLUGIN_DIR"
info "baseURL: $BASE_URL"
info "provider: $PROVIDER_ID"

set +e
edit_config "$BASE_URL"
EDIT_STATUS=$?
set -e
case "$EDIT_STATUS" in
0) ok "config written" ;;
10) ok "config already up to date" ;;
*) die "could not update $CONFIG_FILE" ;;
esac

if [ "$API_KEY_SEEN" = 1 ]; then
  warn "llama-server was started with --api-key, which this plugin does not support yet."
  warn "Remove the flag or expect 401s (API key support is on the backlog)."
fi

if [ "$DRY_RUN" = 1 ]; then
  bold "Dry run"
  info "no files changed, service not restarted"
  exit 0
fi

if [ "$RESTART" = 1 ] && have opencode; then
  if [ "$ASSUME_YES" = 1 ]; then
    info "restarting the OpenCode service"
    opencode service restart >/dev/null 2>&1 || warn "restart failed; run 'opencode service restart' manually"
  elif [ -t 0 ]; then
    answer=""
    read -r -p "Restart the OpenCode service now? [Y/n] " answer || answer=""
    case "$answer" in
    n | N | no | NO) info "skipped; run 'opencode service restart' later" ;;
    *)
      opencode service restart >/dev/null 2>&1 || warn "restart failed; run 'opencode service restart' manually"
      ;;
    esac
  else
    info "restart skipped (not a terminal); run 'opencode service restart'"
  fi
fi

bold "Done"
info "the 'llama' provider should now list the model loaded in llama-server"
info "verify:  opencode plugin list"
info "logs:    grep llamacpp-discover ~/.local/share/opencode/log/opencode.log | tail"
info "refresh: /llama-refresh inside OpenCode"
info "trouble: ./install.sh --doctor"
