# Signing in

Sign in once to use both Gauge Chat and Gauge Agents:

```sh
gauge auth login
```

On a remote terminal, use `gauge auth login --device` and open the displayed
link in your browser. The CLI keeps you signed in automatically. If it asks
you to sign in again, rerun `gauge auth login`.

Use `gauge whoami` to see which account you are using, `gauge auth status` to
check your login, and `gauge auth logout` to sign out this CLI installation.
Local runs do not require a Gauge account.

## API keys for scripts and CI

Create an organization API key in Chat's Settings → API Keys, choosing Read or
Read & write permissions. Supply it through `GAUGE_API_TOKEN` in your shell or
CI secret settings. This overrides your saved login; unset the variable to
return to that login. Logout does not remove or revoke an environment API key.

Replace expired or revoked keys in your script or CI settings. Imported tokens
(`gauge auth login --with-token`) also need replacing when they expire.

## Upgrading from an earlier CLI

If you used an older Agents token, run `gauge auth login` to access Chat and
choose organizations with `gauge orgs`. Unset `GAUGE_API_TOKEN` first if it
contains the old token.

Reselect any previously saved organization with `gauge orgs use <org>`, using
an entry from `gauge orgs`. Add `--project` to update a project's setting;
everyone using that project will need CLI 0.25.0 or later. See
[organization selection](../cli/README.md#organizations).

## Other deployments

`GAUGE_AUTH_URL` (or the `authUrl` setting) chooses the login service;
`GAUGE_API_URL` (or `apiUrl`) chooses the Agents API. Environment variables
win over saved settings. Sign in again after changing servers.
