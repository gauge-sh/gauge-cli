# Local connection credentials

Local connections inject one configured authentication header into outbound HTTPS
requests in local Docker sessions. Secrets stay on the host and in the gateway;
the agent receives no connection environment variables or credential file.
Hosted connections are unchanged.

## Configure a registry

Create `.gauge/connections.yaml` in the project workspace:

```yaml
version: 1
connections:
  - name: supabase
    origin: https://your-project.supabase.co
    header: Authorization
    env: SUPABASE_AUTH
```

`env` is an environment variable **name**, not a token or `${...}` substitution.
Set it in the shell that launches Gauge. Its value is the complete header value,
including any scheme such as `Bearer `. For an API-key header, use that header
name (for example `apikey`) and the raw API key as the environment variable value.
Keep credentials out of the YAML, shell history, prompts, and input files. Use a
separate credential variable for each integration and provider.

Select connections explicitly:

```sh
gauge run "Inspect the Supabase API" --local --connection supabase --dry-run
gauge run "Inspect the Supabase API" --local --connection supabase
```

Repeat `--connection` for multiple names. The flag replaces case-level
connections for that launch. Multiple registry entries may describe different
accounts for the same origin/header, but only one can be selected per case. Cases and saved local evals/preferences can also use
`config.connectionIds` with these names. Use `--connections-file <path>` to select
a different registry. Without a selected connection, no registry is read and no
credential is injected.

Dry runs show connection names, destinations, header names, environment variable
names, and readiness, never values. Launch fails if a selected name is unknown or
a credential is missing, empty, or contains invalid header characters. Unselected
connections do not require environment variables.

## Gateway image during development

The currently published gateway image does not contain this feature. Build the
updated image from this checkout and pass it explicitly:

```sh
docker build -t gauge-gateway:connections packages/local/gateway
gauge run "Inspect the Supabase API" --local --connection supabase \
  --gateway-image gauge-gateway:connections
```

This applies to `--dry-run` and `--detach` too. A gateway that lacks connection
support is rejected before the agent starts. No runtime or gateway is published
by building this feature locally.

## Matching and security boundaries

- `origin` is an exact HTTPS origin on port 443. A trailing slash or explicit
  `:443` is normalized. Paths, queries, fragments, wildcard hosts, IP addresses, credentials,
  and other ports are rejected. All paths at that origin are authorized.
- TLS SNI and the HTTP authority must both match the configured DNS hostname;
  the gateway verifies the upstream TLS certificate. Connections never match HTTP, subdomains, suffix lookalikes, or another port.
  The configured header replaces any existing copies on matching requests.
  Ambiguous authorities, HTTP/1 absolute-form request targets, and non-origin-form
  paths are deliberately not authenticated. Routing, framing, and proxy headers such as `Host`, `Connection`, and
  `Content-Length` cannot be configured.
- Synthetic fixture responses and requests rewritten to fixture upstreams receive
  no injected credentials, even when the source or upstream is a configured
  connection destination.
- Redirects are handled by the HTTP client. Each subsequent request is matched
  independently. Gauge does not inject a credential into an unrelated origin.
- The CLI resolves credentials on the host for each session. A detached batch
  retains its launch environment in its host supervisor. Registry metadata is
  frozen for the batch, but values are not written to batch requests, run specs,
  Docker arguments, container environment variables, or intervention logs.
- Resolved values are written to a temporary host file with mode `0600`, inside
  a `0700` directory, then mounted read-only into the gateway only. The gateway
  copies the file into its private directory before dropping privileges. Existing
  session cleanup removes the temporary file and gateway container after normal
  completion, cancellation, and recoverable startup failures. As with other
  credentials, abrupt host termination may require `gauge cleanup --local`.

Only select a connection when the agent should be able to act with its authority.
The destination service receives the credential and could echo it in a response;
this mechanism does not redact service responses or constrain permitted API
operations. Use a scoped, least-privilege token and a trusted HTTPS destination.
