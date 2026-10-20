import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface BindMount { type: "bind"; source: string; target: string; readonly: boolean }
interface ContainerSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  mounts: BindMount[];
  env: Record<string, string>;
  command: string[];
  interactive?: boolean;
  user?: string;
}

const exec = promisify(execFile);

export class DockerError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`docker ${args[0]} failed: ${stderr.trim() || "unknown error"}`);
  }
}

function mountArg(mount: BindMount): string {
  for (const path of [mount.source, mount.target])
    if (/[,"\n]/.test(path)) throw new Error(`unsupported character in mount path: ${path}`);
  return `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`;
}

const isMissing = (stderr: string) =>
  /No such (container|object|volume)/i.test(stderr);

export class DockerCli {
  constructor(private readonly binary = "docker") {}

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(this.binary, args, {
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? error);
      throw new DockerError(args, stderr);
    }
  }

  async create(spec: ContainerSpec): Promise<"created" | "exists"> {
    const args = [
      "create",
      "--name",
      spec.name,
      "--restart",
      "no",
      "--log-driver",
      "json-file",
      "--log-opt",
      "max-size=1g",
    ];
    if (spec.interactive) args.push("--interactive");
    if (spec.user) args.push("--user", spec.user);
    for (const [key, value] of Object.entries(spec.labels))
      args.push("--label", `${key}=${value}`);
    for (const [key, value] of Object.entries(spec.env))
      args.push("--env", `${key}=${value}`);
    for (const mount of spec.mounts) args.push("--mount", mountArg(mount));
    args.push(spec.image, ...spec.command);
    try {
      await this.run(args);
      return "created";
    } catch (error) {
      if (error instanceof DockerError && /Conflict|already in use/i.test(error.stderr))
        return "exists";
      throw error;
    }
  }

  async assertSessionOwner(name: string, credentialDir: string): Promise<void> {
    let inspection: string;
    try { inspection = await this.run(["inspect", name]); }
    catch (error) {
      if (error instanceof DockerError && isMissing(error.stderr)) return;
      throw error;
    }
    const container = JSON.parse(inspection)[0];
    if (container?.Config?.Labels?.["sh.gauge.session"] !== name ||
        !container?.Mounts?.some((mount: { Source: string; Destination: string }) =>
          mount.Source === `${credentialDir}/workspace` && mount.Destination === "/gauge/session"))
      throw new Error("Refusing cleanup: container ownership does not match the Gauge session");
  }

  async stop(name: string, graceS: number): Promise<void> {
    try {
      await this.run(["stop", "--time", String(graceS), name]);
    } catch (error) {
      if (!(error instanceof DockerError && isMissing(error.stderr))) throw error;
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.run(["rm", name]);
    } catch (error) {
      if (!(error instanceof DockerError && isMissing(error.stderr))) throw error;
    }
  }

}
