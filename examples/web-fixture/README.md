# Transparent HTTPS origin mapping demo

The agent requests `https://example.com/`. The gateway fetches
`https://example.org/` and returns that site's response over the intercepted
HTTPS connection. The agent receives only the case prompt; routing is configured
outside its container. Neither the host's traffic nor other sessions are changed.

From this directory, use the CLI built from this checkout:

```sh
node ../../cli/dist/index.js run --verify --local
node ../../cli/dist/index.js run --dry-run --local -o json
node ../../cli/dist/index.js run --local
```

The last command starts **one real Codex session** using your local credentials.
The preview reports credential readiness, both Docker images, and the selected
origin mapping. The case uses the CLI's default Codex model; edit
`gauge-cases/fetch-page.md` to select a different supported model or harness.

This development checkout must be built (`npm run build` at the repository root).
It needs Docker, the supported agent runtime, and the gateway image. Until the
gateway's first public release, build it from the repository root:

```sh
docker build -t ghcr.io/gauge-sh/gauge-gateway:0.1.0 packages/local/gateway
```

## See the result

The run prints a run ID. From this directory:

```sh
node ../../cli/dist/index.js run get <run-id> --logs --local
cat .gauge/runs/<run-id>/attempts/1/session/gateway.log
cat .gauge/runs/<run-id>/attempts/1/session/diff.patch
```

The transcript shows the agent's fetch and answer. The diff contains its saved
HTML and response headers. The gateway log should contain a record like:

```json
{"action":"rewrite","url":"https://example.com/","method":"GET","target":"https://example.org/"}
```

The two example domains can serve similar content. The gateway's rewrite record
is the direct evidence of which upstream was selected; the page title alone is
not sufficient. This demo performs a live origin mapping, without modifying the
response body. It therefore also requires network access to the upstream site.

For background execution, use `run --detach --local`; it prints status, wait,
and cancel commands. Ctrl+C cancels a foreground run and cleans up its containers.
