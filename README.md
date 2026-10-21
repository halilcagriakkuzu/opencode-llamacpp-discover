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

### Prerequisites

- OpenCode v2 (check with `opencode --version`).
- A running `llama-server`, for example:

  ```bash
  llama-server -m /path/to/model.gguf --port 8080
  ```

- `git` (or download the repository as a ZIP).

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

### Option A — plugin entry in your config (recommended)

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

### Option B — auto-load directory (single file)

Copy `src/index.ts` to the global plugin directory for your platform (see the
table above), as `llamacpp-discover.ts`. OpenCode loads files from that
directory automatically, so no config entry is needed. Do not use both options
at once, or the plugin loads twice.

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

- Update: `git pull` in the clone (Option A) or copy `src/index.ts` again
  (Option B), then restart OpenCode (`opencode service restart`).
- Uninstall: remove the `plugins` entry or the copied file, then restart.
  The plugin never writes to your config, so nothing else needs cleaning up.

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
- **Plugin seems inactive** — make sure `disabled` is not set to `true`.

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

If the server is unreachable or sleeping, the last known inventory is kept.

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
