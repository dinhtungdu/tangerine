import type { Provider } from "./types.ts";
import { LimaProvider } from "./lima.ts";
import { IncusProvider } from "./incus.ts";
import { TEMPLATE_PATH } from "../../image/build.ts";

export type ProviderType = "lima" | "incus";

export function createProvider(
  type: ProviderType,
  config?: Record<string, string>
): Provider {
  switch (type) {
    case "lima": {
      const templatePath =
        config?.templatePath ??
        process.env.TANGERINE_LIMA_TEMPLATE ??
        TEMPLATE_PATH;
      return new LimaProvider({ templatePath });
    }
    case "incus": {
      return new IncusProvider({
        cpus: config?.cpus ? parseInt(config.cpus, 10) : undefined,
        memory: config?.memory,
        remote: config?.remote,
        sshPubKeyPath: config?.sshPubKeyPath,
      });
    }
    default:
      throw new Error(`Unknown provider: ${type}`);
  }
}

export type { Provider, Instance, Snapshot, CreateInstanceOptions } from "./types.ts";
