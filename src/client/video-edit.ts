import type { RegisterClientOptions } from "@peertube/peertube-types/client";
import { FIELD_CELLULOID_PROJECT } from "../constants";

function register({ registerVideoField }: RegisterClientOptions): void {
  const commonOptions = {
    name: FIELD_CELLULOID_PROJECT,
    label: "Celluloid project",
    descriptionHTML:
      "Celluloid project ID or URL (e.g. https://celluloid.me/project/&lt;id&gt;). " +
      "Its annotations will be displayed over this video. You can also link a project from the watch page.",
    type: "input" as const,
    default: "",
  };

  const videoFormTypes = [
    "upload",
    "import-url",
    "import-torrent",
    "update",
    "go-live",
  ] as const;

  for (const type of videoFormTypes) {
    registerVideoField(commonOptions, { type, tab: "main" });
  }
}

export { register };
