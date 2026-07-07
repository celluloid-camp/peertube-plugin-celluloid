import type { RegisterServerOptions } from "@peertube/peertube-types";
import {
  extractProjectId,
  fetchProjectAnnotations,
  normalizeCelluloidUrl,
} from "./celluloid";
import {
  FIELD_CELLULOID_PROJECT,
  SETTING_CELLULOID_URL,
  projectStorageKey,
} from "./constants";

const DEFAULT_CELLULOID_URL = "https://celluloid.me";

export async function register({
  registerHook,
  registerSetting,
  settingsManager,
  storageManager,
  getRouter,
  peertubeHelpers,
}: RegisterServerOptions): Promise<void> {
  const logger = peertubeHelpers.logger;

  registerSetting({
    name: SETTING_CELLULOID_URL,
    label: "Celluloid instance URL",
    type: "input",
    default: DEFAULT_CELLULOID_URL,
    // Public so the client scripts can read it through getSettings().
    private: false,
    descriptionHTML:
      "Base URL of the Celluloid instance exposing the API, e.g. <code>https://celluloid.me</code>.",
  });

  // Persist the linked project when a video is created or updated.
  const storeProjectFromRequest = async (params: {
    video: { uuid: string };
    req?: { body?: { pluginData?: Record<string, unknown> } };
  }) => {
    const { video, req } = params;
    const pluginData = req?.body?.pluginData;
    if (!video?.uuid || !pluginData) return;
    if (!(FIELD_CELLULOID_PROJECT in pluginData)) return;

    const value = pluginData[FIELD_CELLULOID_PROJECT];
    const key = projectStorageKey(video.uuid);
    if (value === undefined || value === null || value === "") {
      await storageManager.storeData(key, null);
      return;
    }
    await storageManager.storeData(key, String(value));
  };

  for (const target of [
    "action:api.video.updated",
    "action:api.video.uploaded",
  ] as const) {
    registerHook({ target, handler: storeProjectFromRequest });
  }

  // Autofill the edit form field with the stored value.
  registerHook({
    target: "filter:api.video.get.result",
    handler: async (video: {
      uuid?: string;
      pluginData?: Record<string, unknown>;
    }) => {
      if (!video?.uuid) return video;
      if (!video.pluginData) video.pluginData = {};
      video.pluginData[FIELD_CELLULOID_PROJECT] =
        (await storageManager.getData(projectStorageKey(video.uuid))) ?? "";
      return video;
    },
  });

  // Proxy endpoint used by the watch-page client script.
  // Avoids cross-origin (CORS) calls straight to the Celluloid instance.
  const router = getRouter();
  router.get("/videos/:uuid/annotations", async (req, res) => {
    try {
      const reference = (await storageManager.getData(
        projectStorageKey(req.params.uuid),
      )) as string | null;

      if (!reference) {
        res.json({ linked: false });
        return;
      }

      const celluloidUrl = normalizeCelluloidUrl(
        ((await settingsManager.getSetting(SETTING_CELLULOID_URL)) as string) ||
          DEFAULT_CELLULOID_URL,
      );
      const projectId = extractProjectId(reference);
      const { project, annotations } = await fetchProjectAnnotations(
        celluloidUrl,
        projectId,
      );

      res.json({
        linked: true,
        celluloidUrl,
        projectId,
        project,
        annotations,
      });
    } catch (err) {
      logger.error("[celluloid] failed to fetch annotations", { err });
      res.status(502).json({ error: "Unable to fetch Celluloid annotations" });
    }
  });
}

export async function unregister(): Promise<void> {
  // Nothing to clean up: hooks and routes are removed by PeerTube.
}
