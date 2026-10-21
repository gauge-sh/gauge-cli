# Shared CLI authentication

Shared authentication is initially opt-in, after the Chat and Agents server
changes have been deployed and enabled:

```sh
gauge config set authUrl https://app.withgauge.com
gauge auth login
# Remote terminals can use: gauge auth login --device
```

`GAUGE_AUTH_URL` overrides `authUrl`. `GAUGE_API_URL` / `apiUrl` still select the
Agents data API. Without an explicit auth URL, login retains the existing Agents
flow during rollout. A later release can switch the default after server rollout.

Chat handles browser consent, device approval, credential issuance, refresh, and
revocation. One opaque access token works with both APIs. Agents asks Chat for
current identity and authorization; memberships and roles are not embedded in the
token. `auth status` and `whoami` use Chat for shared credentials, including users
who do not yet have an Agents workspace.

The CLI stores access and rotating refresh credentials in an owner-only, atomically
replaced credentials file. Existing plaintext tokens remain readable.
`GAUGE_API_TOKEN` and explicitly supplied tokens retain precedence and are never
automatically refreshed. Imported shared access tokens (`login --with-token`) have
no refresh credential and therefore must be replaced when they expire.

Refresh runs before expiry and once after an HTTP 401, including event-stream
handshakes. A permission denial or service outage is not treated as a reason to
refresh. A failed early renewal leaves a still-valid token usable. Requests with
ambiguous network failures are not replayed. If a refresh response is lost after
server-side rotation, sign in again: replaying the old refresh token revokes its
grant. Concurrent CLI processes serialize rotation through a lock file. If a
process crashes while holding the lock, the error names the file to remove after
confirming no Gauge process is running.

Stored shared credentials are bound to the Chat and Agents origins chosen at
login. Changing API hosts requires explicitly logging in for the new host.
Credential-bearing HTTP requests do not follow redirects.

`auth logout` revokes the shared grant and clears local credentials. If Chat is
unreachable, local credentials are still cleared and the CLI reports that remote
revocation failed. Environment credentials are unchanged. `auth tokens` manages
legacy Agents tokens; shared sessions cannot mint legacy tokens that would escape
the shared grant's revocation.

Local execution and existing Agents credentials do not require this opt-in.
