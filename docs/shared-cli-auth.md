# Shared CLI authentication

Shared authentication is the default for browser and device login:

```sh
gauge auth login
# Remote terminals can use: gauge auth login --device
```

Login uses `https://app.withgauge.com` without any configuration. For development
or alternate deployments, `GAUGE_AUTH_URL` overrides `authUrl`.
`GAUGE_API_URL` / `apiUrl` still select the Agents data API. Deploy and enable
shared authentication on both Chat and Agents before releasing this CLI version.

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
refresh. A rate-limited early renewal leaves a still-valid token usable. Before sending
a refresh, the CLI persists a pending marker under its credential lock. Only a
confirmed rotation saved to disk or a definite pre-rotation rate-limit rejection
clears that marker. Network/server errors, malformed responses, process death,
and credential-save failures require another login; later commands cannot
automatically replay the old refresh token. Logout retains access to the old
refresh secret for revocation. A dead process may also leave a lock file: remove
it only after confirming no Gauge process is running. Removing the lock does
not remove the pending marker. Replaying a consumed refresh token revokes its
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

Local execution is unchanged. Existing stored and imported Agents tokens can
still identify the user, manage legacy tokens, and access Agents by canonical
organization UUID. They cannot access the shared organization directory. Use
`gauge auth login` for public slug selection; unset `GAUGE_API_TOKEN` if it
contains a legacy token. The next browser or device login creates a shared
session.

`gauge whoami` identifies the user or organization API key. `gauge auth status`
validates the active credential and reports its source, scopes, expiry, and API
URLs. Shared sessions and API keys use the public Chat `/api/v1/me` endpoint;
legacy credentials use Agents `/api/v1/me`. Only `whoami` lists organizations,
using the canonical directory for shared sessions and the owning organization
for API keys.

## Upgrading to 0.25.0

Run `gauge orgs` and reselect your public Gauge slug with `gauge orgs use <slug>`.
For a project with an old `org` field, use `gauge orgs use <slug> --project`.
The CLI stores a canonical `orgId`; it does not guess whether the old slug
belonged to Chat or Agents. Shared project files using `orgId` require 0.25.0 or
later. Existing Agents tokens still work for direct requests with canonical UUIDs;
public slug selection requires shared login. See the
[organization compatibility details](../cli/README.md#organizations).

`GAUGE_API_TOKEN` overrides stored login credentials. If it contains an old
Agents token, unset it before using shared login for Chat or the organization
directory. For automation, organization API keys from Chat Settings → API Keys
use their configured read/write scopes. Chat defaults to the key's owning
organization; Agents commands require an explicit or saved organization.
Agents must have organization API-key support enabled in the target deployment.
API keys do not provide user-scoped Agents MCP delegation; connect MCP through
OAuth for Agents tools.
