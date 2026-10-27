# Releasing

Release workflows publish only from `gauge-sh/gauge-cli`. Package checks and
custom-runtime checks can run in forks without Gauge or provider credentials.

## Repository and registry setup

These settings live outside the repository and must be configured before the
first release:

1. Enable GitHub Actions in the public repository with default branch `main`.
   Allow the actions used in `.github/workflows/` and the Ubuntu and macOS
   runners used by the checks. Protect `main` and restrict creation of release
   tags to maintainers. Configure approval for workflows submitted from forks
   according to the project's contribution policy.
2. Configure npm trusted publishing for the `gauge-sh/gauge-cli` repository:

   | Package | Workflow filename | Tag |
   | --- | --- | --- |
   | `@withgauge/cli` | `publish-cli.yml` | `cli-v<version>` |
   | `@withgauge/agent-adapters` | `publish-agent-adapters.yml` | `agent-adapters-v<version>` |
   | `@withgauge/local-execution` | `publish-local-execution.yml` | `local-execution-v<version>` |

   Use the filename without `.github/workflows/`. No GitHub environment is
   configured in these workflows. They authenticate through GitHub OIDC and
   publish with npm provenance; they do not require an npm token secret.
   Update trusted publishers when changing the repository identity.
   The package's `repository.url` must match the publishing repository.
   See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
3. Keep `ghcr.io/gauge-sh/gauge-runtime` public and connect it to
   `gauge-sh/gauge-cli`. In the package's **Manage Actions access** settings,
   grant this repository write access. Linking an existing package does not
   necessarily enable permission inheritance, so verify this explicitly before
   the first runtime release. The package name and existing digests can stay
   unchanged when the source repository changes.
   See [GitHub package permissions](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
   and [connecting a package to a repository](https://docs.github.com/en/packages/learn-github-packages/connecting-a-repository-to-a-package).
4. Keep `ghcr.io/gauge-sh/gauge-gateway` public and connected to
   `gauge-sh/gauge-cli` with Actions write access, like the runtime package.
   If a new package is ever created private, the workflow's anonymous-pull
   jobs fail until it is made public; then rerun them.

Source and Git history are separate review surfaces. When creating a repository
with a fresh history, copy the reviewed source tree rather than pushing old
branches and tags. Do not import historical release tags as new releases.

## Runtime, then CLI

Each CLI release pins an anonymously pullable, qualified multi-platform runtime
in `cli/runtime-manifest.json`. Its `revision` identifies the commit that built
the image. CLI validation compares the checked-out runtime source against that
commit, so a full clone must contain it.

If the source revision is absent after starting a fresh repository history,
publish a new runtime version from the public repository before releasing the
CLI. Do not replace the old revision or digest with a new value without
qualifying the corresponding image.

1. On `main`, choose a new runtime version in `cli/runtime-manifest.json`.
   Set `digest` and `revision` to `null` while preparing that release. Commit the
   change and push `runtime-v<version>` pointing to the reviewed commit.
2. The runtime workflow tests both native architectures, publishes the images
   and index, and verifies anonymous pulls using the packaged CLI. Existing
   version tags are immutable; choose a new version if the source changed.
3. Download the successful workflow's `qualified-runtime-manifest` artifact.
   Commit it as `cli/runtime-manifest.json` through a reviewed PR.
4. Update `cli/package.json`, its lockfile, and the dated CLI changelog entry.
   The `Unreleased` section must be empty. Run:

   ```sh
   npm run check
   npm run release:validate --prefix cli -- cli-v<version>
   ```

5. After merging, push `cli-v<version>` at a commit on `main`. The CLI workflow
   validates and publishes the exact tarball it tested, including an anonymous
   pull of its pinned runtime.

The two library workflows similarly require aligned package versions,
lockfiles, changelogs, and release tags. They test the packed artifacts before
publishing. Tags must use versions that have not already been published.

Changing the runtime source requires another runtime release and reviewed
manifest pin. CLI-only changes can reuse a qualified runtime when its source
revision remains available and the runtime source has not changed.

## Gateway

Each CLI release also pins the local web-fixture gateway image in
`cli/gateway-manifest.json`. The gateway is released independently of the
runtime through `.github/workflows/gateway.yml`, using the same steps:

1. On `main`, choose a new gateway version in `cli/gateway-manifest.json` with
   `digest` and `revision` set to `null`. Commit it and push
   `gateway-v<version>` pointing to the reviewed commit.
2. The workflow qualifies `packages/local/gateway` on both native
   architectures against the pinned runtime, publishes the images and index,
   and verifies anonymous pulls.
3. Commit the `qualified-gateway-manifest` artifact as
   `cli/gateway-manifest.json` through a reviewed PR before releasing the CLI.

If a native image push fails with a transient registry error such as
`unknown blob`, rerun the failed jobs. A platform tag that was never written
is published normally on rerun, and one that exists is reused only when it
was built from the same commit.

The same workflow runs qualification without publishing on pull requests that
change `packages/local/`. Because gateway qualification uses the pinned
runtime, release and pin a changed runtime first. Changing
`packages/local/gateway` requires another gateway release and reviewed pin.

## Hosted API compatibility

Before publishing a CLI release that changes authentication or organization
selection, verify the candidate package against the deployed Chat and Agents
APIs. Check shared browser/device consent, refresh, logout, canonical public
slugs, old-client compatibility, and cross-organization denial. Run analytical
checks only as reads against approved existing data. Use disposable fixtures
for writes, then remove their memberships and revoke credentials.

For 0.25.0, the servers must expose the Chat public API and canonical directory,
shared CLI authentication, and Agents canonical organization resolution. Deploy
Gauge Chat #2349 and recheck the advertised HTTPS device URL. Enable Agents
organization API keys and verify live introspection before claiming cross-product
API-key support. Chat's Agents MCP rollout is independent of CLI publishing;
MCP connections using API keys still need OAuth to delegate Agents requests.

The CLI's credential-prefix classification also needs separate qualification in
hosted sessions that receive credential placeholders. Ordinary CLI checks do not
establish that injected connections work. Keep that pilot separate from package
build, unit, and packed-artifact checks.
