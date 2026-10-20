import { execFileSync, spawn } from "node:child_process";
import manifest from "../../runtime-manifest.json";
import { CliError } from "./client";

export const RUNTIME_MANIFEST = manifest;
export const RUNTIME_IMAGE = manifest.digest
  ? `${manifest.repository}@${manifest.digest}`
  : `${manifest.repository}:${manifest.version}`;

export type RuntimeInspection = {
  reference: string;
  expectedContract: string;
  supportedPlatforms: string[];
  dockerPlatform?: string;
  imageId?: string;
  repoDigest?: string;
  contract?: string;
  platform?: string;
  ready: boolean;
  problem?: { code: string; message: string; hint: string };
};
export type DockerRead = (args: string[]) => string;
const dockerRead: DockerRead = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });

export function inspectLocalRuntime(
  image = RUNTIME_IMAGE,
  docker: DockerRead = dockerRead,
): RuntimeInspection {
  const result: RuntimeInspection = {
    reference: image,
    expectedContract: manifest.contract,
    supportedPlatforms: manifest.platforms,
    ready: false,
  };
  const fail = (code: string, message: string, hint: string) => ({
    ...result,
    problem: { code, message, hint },
  });
  let server: { Os: string; Arch: string };
  try {
    server = JSON.parse(docker(["version", "--format", "{{json .Server}}"]));
    if (!server?.Os || !server.Arch) throw new Error("No Docker server");
  } catch {
    return fail("docker_unavailable", "Local runs need a running Docker daemon.",
      "Start Docker Desktop (using Linux containers) or the Docker daemon, then retry.");
  }
  result.dockerPlatform = `${server.Os}/${server.Arch}`;
  if (!manifest.platforms.includes(result.dockerPlatform))
    return fail("platform_unsupported", `Docker ${server.Os}/${server.Arch} is not a qualified runtime platform.`,
      `Supported native Docker platforms: ${manifest.platforms.join(", ")}. Emulation is not qualified.`);
  let details: { Id: string; RepoDigests?: string[]; Os: string; Architecture: string; Config?: { Labels?: Record<string, string> } };
  try {
    [details] = JSON.parse(docker(["image", "inspect", image]));
  } catch {
    return fail("image_missing", `Local runs need the ${image} Docker image.`,
      image === RUNTIME_IMAGE ? "Run: gauge local runtime pull" : `Pull or build the selected runtime image: ${image}`);
  }
  if (!details?.Id || !details.Os || !details.Architecture)
    return fail("image_invalid", `Docker returned incomplete image metadata for ${image}.`,
      "Check docker image inspect for the selected image.");
  result.imageId = details.Id;
  result.repoDigest = details.RepoDigests?.find((digest) => digest.startsWith(`${manifest.repository}@`)) ?? details.RepoDigests?.[0];
  result.contract = details.Config?.Labels?.["sh.gauge.contract"];
  result.platform = `${details.Os}/${details.Architecture}`;
  if (result.contract !== manifest.contract)
    return fail("contract_unsupported", `Runtime contract ${result.contract ?? "(missing)"} is unsupported; expected ${manifest.contract}.`,
      "Use a runtime derived from the supported Gauge image and preserve its contract.");
  if (!manifest.platforms.includes(result.platform) || server.Os !== details.Os || server.Arch !== details.Architecture)
    return fail("platform_unsupported", `Runtime ${result.platform} is not supported on Docker ${server.Os}/${server.Arch}.`,
      `Supported native Docker platforms: ${manifest.platforms.join(", ")}. Emulation is not qualified.`);
  result.ready = true;
  return result;
}

export function requireLocalRuntime(image = RUNTIME_IMAGE): RuntimeInspection & { imageId: string } {
  const result = inspectLocalRuntime(image);
  if (!result.ready) {
    const problem = result.problem!;
    throw new CliError(problem.code === "image_missing" || problem.code === "docker_unavailable" ? "not_found" : "usage", problem.message, { hint: problem.hint });
  }
  return result as RuntimeInspection & { imageId: string };
}
export const resolveLocalRuntime = requireLocalRuntime;

export function runtimeProblem(): CliError | undefined {
  try { requireLocalRuntime(); } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
}

export async function pullLocalRuntime(): Promise<RuntimeInspection> {
  const before = inspectLocalRuntime();
  if (!before.dockerPlatform || !manifest.platforms.includes(before.dockerPlatform)) {
    const problem = before.problem!;
    throw new CliError(problem.code === "docker_unavailable" ? "not_found" : "usage", problem.message, { hint: problem.hint });
  }
  const platform = before.dockerPlatform;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", ["pull", "--platform", platform, RUNTIME_IMAGE], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stderr);
    child.stderr.pipe(process.stderr);
    child.once("error", () => reject(new CliError("not_found", "Docker could not start.", { hint: "Install and start Docker, then retry." })));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new CliError("network", `Could not pull ${RUNTIME_IMAGE}.`, { hint: "Check the network and public registry availability, then retry gauge local runtime pull." })));
  });
  return requireLocalRuntime();
}
