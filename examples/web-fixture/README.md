# Web fixture example: routing an origin

This example starts one agent session that fetches `https://example.com/`. The
fixture in `fixtures/example-site.json` maps that origin to
`https://example.org/`, so the gateway fetches `example.org` and returns its
response over the intercepted HTTPS connection. The agent gets only the case
prompt and runs nothing extra for routing. Your host's traffic and other
sessions are not affected.

See [web fixture inputs](../../docs/local-web-fixtures.md) for the full format.

## Requirements

- Docker.
- Local credentials for Codex. The case uses the CLI's default Codex model;
  edit `gauge-cases/fetch-page.md` to choose another model or agent.
- Network access to `example.org`, since this is a live origin mapping.

The commands below use the CLI built from this checkout. Run `npm run build` at
the repository root first. With an installed CLI, replace
`node ../../cli/dist/index.js` with `gauge`.

## Run it

From this directory:

```sh
node ../../cli/dist/index.js local runtime pull
node ../../cli/dist/index.js run --verify --local
node ../../cli/dist/index.js run --dry-run --local -o json
node ../../cli/dist/index.js run --local
```

`local runtime pull` downloads the agent runtime and gateway images. The dry
run reports credential readiness, both images, and the origin mapping. The
last command starts **one real Codex session**.

Ctrl+C cancels a foreground run and removes its containers. To run in the
background, use `run --detach --local`, which prints status, wait, and cancel
commands.

## Check the result

The run prints a run ID. From this directory:

```sh
node ../../cli/dist/index.js run get <run-id> --logs --local
cat .gauge/runs/<run-id>/attempts/1/session/gateway.log
cat .gauge/runs/<run-id>/attempts/1/session/diff.patch
```

The transcript shows the agent's fetch and answer, and the diff contains the
HTML and response headers it saved. The gateway log should contain a line like:

```json
{"at": "2026-10-26T02:33:37.615937+00:00", "action": "rewrite", "url": "https://example.com/", "method": "GET", "target": "https://example.org/"}
```

The two domains can serve similar pages, so the page title alone doesn't show
which site answered. The `rewrite` record in the gateway log does.
