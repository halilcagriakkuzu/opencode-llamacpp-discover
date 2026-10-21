# opencode-llamacpp-discover

An [OpenCode](https://opencode.ai) **v2** plugin that auto-detects the model
loaded in a local [llama.cpp](https://github.com/ggml-org/llama.cpp)
`llama-server`, so swapping models never means hand-editing `opencode.json`.

It reads everything from llama-server's own endpoints (`/v1/models`, `/props`)
— no extra server, no probe requests that cost GPU time:

- **Model** — id, display name, aliases
- **Context window** — the live `n_ctx` (after `--fit` / `-c`), not a stale config value
- **Thinking** — whether the model reasons, plus the supported effort levels
  (parsed from the chat template) exposed as OpenCode variants
- **Vision** — image input only when the server has an `mmproj` loaded
- **Tools** — tool-call support
- **Output limit** — from the server, with a fallback when it is unlimited
- **Idle-sleeping servers** — works with `--sleep-idle-seconds`: the server
  still serves model metadata, so the model is registered and llama.cpp loads
  it on the first request

If no provider entry exists in your config, the plugin creates one at runtime
(it never writes to your config files).

## Tested with

| Component | Version |
|---|---|
| OpenCode | v2.0.32 (written for OpenCode v2; v1 is not supported) |
| llama.cpp (`llama-server`) | 0.7.0-dev (build 11708, commit 83f938941) — new `/props` layout with `chat_template_caps` and `modalities` |

Older llama.cpp builds fall back to the flat `/props` layout, but that path is
only covered by fixtures, not by real servers.

## Install

One command, from a clone of this repository:

```bash
git clone https://github.com/halilcagriakkuzu/opencode-llamacpp-discover.git
cd opencode-llamacpp-discover
./install.sh
```

That is the whole install. It needs OpenCode v2 and a running `llama-server`
(for example `llama-server -m /path/to/model.gguf`, default port 8080). The
script finds the server, writes the `plugins` entry into your global
`opencode.jsonc` (backing the file up first), restarts OpenCode, and prints what
it found. After that, pick the `llama` model in the model picker.

If anything looks wrong:

```bash
./install.sh --doctor
```

## Advanced install

### Requirements

- OpenCode v2 (check with `opencode --version`). V1 plugins do not run in V2.
- A running `llama-server`:

  ```bash
  llama-server -m /path/to/model.gguf --port 8080
  ```

- `git` (or download the repository as a ZIP).
- `curl` and `python3` for `install.sh` (present on almost every Linux/WSL/macOS
  install; `python3` is only used to edit the config safely).

### install.sh options

`./install.sh` detects the server, updates the config, and restarts OpenCode.
All flags are optional.

| Flag | Purpose |
|---|---|
| `--url URL` | Skip detection and use this server (root or `…/v1`) |
| `--dry-run` | Show the change without writing or restarting |
| `--doctor` | Print diagnostics (OpenCode version, config, ports, WSL, log) |
| `--config FILE` | Edit a specific config file |
| `--plugin-dir DIR` | Register a different clone |
| `--provider-id ID` | Provider ID (default `llama`) |
| `--yes` | Unattended: pick the first match and restart |
| `--no-restart` | Leave the OpenCode service alone |

Examples:

```bash
./install.sh --url http://127.0.0.1:8090/v1   # fix a non-default port
./install.sh --dry-run                        # preview the config change
./install.sh --doctor                         # why is nothing showing up?
./install.sh --yes --no-restart               # unattended, no service restart
```

How detection works: it reads running `llama-server` command lines and probes
common ports, but accepts a port only when `/props` returns llama.cpp JSON, so
an unrelated service on 8080 is ignored. If detection fails, start
`llama-server` first or pass `--url`.

On WSL, a server running on the Windows side must listen on all interfaces
(`--host 0.0.0.0`) and be allowed through the Windows firewall for WSL to reach
it; the script explains this when it detects WSL.

### Config file locations

OpenCode uses the same XDG-style layout on every platform; only the home
directory differs. Pick the row for your system:

| Platform | Global config | Global plugin directory |
|---|---|---|
| Linux | `~/.config/opencode/opencode.jsonc` | `~/.config/opencode/plugins/` |
| WSL | `~/.config/opencode/opencode.jsonc` (inside the WSL distro) | `~/.config/opencode/plugins/` |
| macOS | `~/.config/opencode/opencode.jsonc` | `~/.config/opencode/plugins/` |
| Windows | `%USERPROFILE%\.config\opencode\opencode.jsonc` | `%USERPROFILE%\.config\opencode\plugins\` |

Notes:

- If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/` instead of
  `~/.config/opencode/`.
- `opencode.json` works too — OpenCode accepts both JSON and JSONC.
- On WSL, edit the file inside the Linux home (`echo $HOME`), **not** the
  Windows-side `C:\Users\...` path. The two are separate OpenCode installs.
- Project config is `opencode.json(c)` or `.opencode/opencode.json(c)` in the
  project directory.

### Manual option A — plugin entry in your config

Use this if you do not want to run `install.sh`.

1. Clone the repository anywhere:

   ```bash
   git clone https://github.com/halilcagriakkuzu/opencode-llamacpp-discover.git
   ```

2. Add it to your OpenCode config using the **absolute path** of the clone.
   Use forward slashes even on Windows (`C:/Users/you/...`) or an escaped
   backslash path:

   ```jsonc
   {
     "plugins": [
       {
         "package": "/absolute/path/to/opencode-llamacpp-discover",
         "options": { "baseURL": "http://127.0.0.1:8080/v1" }
       }
     ]
   }
   ```

### Manual option B — auto-load directory (single file)

Copy `src/index.ts` to the global plugin directory for your platform (see the
table above), as `llamacpp-discover.ts`. OpenCode loads files from that
directory automatically, so no config entry is needed. Do not use both options
at once, or the plugin loads twice. This only works with the default base URL
(`http://127.0.0.1:8080/v1`); for any other port use option A.

### Verify

1. Restart OpenCode. If it runs as a background service, restart it with:

   ```bash
   opencode service restart
   ```

   Otherwise just quit and start OpenCode again.
2. Open the model picker: the `llama` provider should list the model loaded in
   llama-server, with its real context size and thinking variants.
3. Look for a `[llamacpp-discover]` summary line in the OpenCode log:
   - Linux/macOS/WSL: `~/.local/share/opencode/log/opencode.log`
   - Windows: `%USERPROFILE%\.local\share\opencode\log\opencode.log`

### Update and uninstall

- Update with `install.sh`: `git pull` in the clone, then run `./install.sh`
  again (it reuses the existing entry) or just `opencode service restart`.
- Update a manual install: `git pull` (option A) or copy `src/index.ts` again
  (option B), then restart OpenCode.
- Uninstall: remove the `plugins` entry (option A) or the copied file
  (option B), then restart. The plugin never writes to your config, so nothing
  else needs cleaning up.


### Troubleshooting

- **No models listed** — check that llama-server is reachable at `baseURL`
  (`curl http://127.0.0.1:8080/props`) and that the port matches.
  The default port is 8080; use `baseURL` or `LLAMACPP_DISCOVER_BASE_URL`
  for anything else.
- **WSL: llama-server runs on Windows** — `127.0.0.1` inside WSL may not reach
  a server bound to Windows. Use the Windows host IP
  (`ip route show default | awk '{print $3}'`) or make llama-server listen on
  `0.0.0.0` and allow it through the Windows firewall.
- **Model changed but OpenCode still shows the old one** — run `/llama-refresh`.
- **Plugin seems inactive** — make sure `disabled` is not set to `true`, that the
  config uses the V2 `plugins` key (not V1 `plugin`), and that
  `opencode --version` reports v2. `./install.sh --doctor` checks all of these.
- **Server sleeps and no models appear** — update to this version: a sleeping
  (`--sleep-idle-seconds`) server is discovered from `/props` + `/v1/models`
  metadata instead of being skipped.

## Configuration

Precedence: plugin `options` > environment variables > defaults.

| Option | Environment variable | Default | Purpose |
|---|---|---|---|
| `baseURL` | `LLAMACPP_DISCOVER_BASE_URL` | `http://127.0.0.1:8080/v1` | llama-server OpenAI-compatible base (ends in `/v1`) |
| `providerID` | `LLAMACPP_DISCOVER_PROVIDER_ID` | `llama` | OpenCode provider to populate or create |
| `providerName` | — | `Local llama.cpp` | Display name when the provider is created |
| `outputLimit` | — | `8192` | Output limit when the server reports unlimited |
| `refreshOnConfigUpdate` | — | `true` | Re-apply on `config.updated` |
| `disabled` | — | `false` | Kill switch |

Example using an environment variable (llama-server on port 8090):

```bash
export LLAMACPP_DISCOVER_BASE_URL=http://127.0.0.1:8090/v1   # Linux/macOS/WSL
```

```powershell
$env:LLAMACPP_DISCOVER_BASE_URL = "http://127.0.0.1:8090/v1"  # Windows PowerShell
```

or in the config, via OpenCode's variable substitution:

```jsonc
{ "plugins": [{ "package": "/path/to/plugin", "options": { "baseURL": "{env:LLAMA_URL}" } }] }
```

Per-project overrides: put a different `options` block in the project's
`opencode.json(c)` (or `.opencode/opencode.json(c)`).

## Refreshing

There is no background polling. Discovery runs:

1. at startup,
2. when you run **`/llama-refresh`**,
3. on config changes (re-applies the cached inventory, no HTTP request).

If the server is unreachable, the last known inventory is kept.

### Servers that sleep

llama.cpp can unload an idle model with `--sleep-idle-seconds`. A sleeping
server still answers `/props` and `/v1/models` with the loaded model's metadata,
so discovery works normally (the log line says `sleeping: yes`) and OpenCode
lists the model. llama.cpp loads the weights again on the first request, so no
wake-up probe is needed.

This is not polled either. If the server goes to sleep after startup, the model
list stays valid; if you change the model, run `/llama-refresh`.

## How thinking levels are detected

The plugin reads the Jinja `chat_template` from `/props` and extracts the
`reasoning_effort` whitelist, its default, level aliases, and whether
`enable_thinking=false` is supported. Each level becomes a model variant, plus
`default` and `none`. Variants you define in your own config win over
auto-generated ones.

## Limitations

- One model per llama-server instance; multiple instances need separate plugin
  entries with different `providerID`s.
- Not tested with llama-server router mode.
- Remote servers must be reachable without authentication (see backlog).
- Only the `llama.cpp` server is supported, not other OpenAI-compatible servers.

## Backlog

- API key support for `llama-server --api-key`.
- Unit tests (template parser, model records, merge rules).

## License

[Unlicense](LICENSE) — public domain, use it however you like.
