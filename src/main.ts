import type { RegisterServerOptions } from "@peertube/peertube-types";
import {
  extractShareCode,
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

  // Persist the linked share code when a video is created or updated via the form.
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
    await storageManager.storeData(key, extractShareCode(String(value)));
  };

  for (const target of [
    "action:api.video.updated",
    "action:api.video.uploaded",
  ] as const) {
    registerHook({ target, handler: storeProjectFromRequest });
  }

  // Autofill the manage-form field with the stored value.
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

  const getCelluloidUrl = async (): Promise<string> =>
    normalizeCelluloidUrl(
      ((await settingsManager.getSetting(SETTING_CELLULOID_URL)) as string) ||
        DEFAULT_CELLULOID_URL,
    );

  // Returns the authenticated user, or null for anonymous requests.
  const getUser = async (res: unknown): Promise<AuthUser | null> => {
    try {
      return ((await peertubeHelpers.user.getAuthUser(
        res as never,
      )) as AuthUser | null) ?? null;
    } catch {
      return null;
    }
  };

  // A user may link a video if they are admin/moderator or own the video.
  const canEditVideo = async (
    user: AuthUser | null,
    uuid: string,
  ): Promise<boolean> => {
    if (!user) return false;
    // 0 = administrator, 1 = moderator
    if (user.role === 0 || user.role === 1) return true;

    try {
      const rows = (await peertubeHelpers.database.query(
        `SELECT account."userId" AS "userId"
         FROM "video"
         INNER JOIN "videoChannel" ON "videoChannel"."id" = "video"."channelId"
         INNER JOIN "account" ON "account"."id" = "videoChannel"."accountId"
         WHERE "video"."uuid" = :uuid
         LIMIT 1`,
        { replacements: { uuid }, type: "SELECT" },
      )) as Array<{ userId: number }>;
      return rows?.[0]?.userId === user.id;
    } catch (err) {
      logger.error("[celluloid] ownership check failed", { err });
      return false;
    }
  };

  const parseBody = (req: {
    body?: unknown;
    rawBody?: Buffer;
  }): Record<string, unknown> => {
    if (req.body && typeof req.body === "object") {
      return req.body as Record<string, unknown>;
    }
    if (req.rawBody) {
      try {
        return JSON.parse(req.rawBody.toString());
      } catch {
        /* ignore */
      }
    }
    return {};
  };

  const router = getRouter();

  // Read endpoint used by the watch-page client script.
  // Public: anonymous viewers can read a project's (public) annotations.
  // Avoids cross-origin (CORS) calls straight to the Celluloid instance.
  router.get("/videos/:uuid/annotations", async (req, res) => {
    try {
      const uuid = req.params.uuid;
      const reference = (await storageManager.getData(
        projectStorageKey(uuid),
      )) as string | null;

      const user = await getUser(res);
      const canEdit = await canEditVideo(user, uuid);
      const celluloidUrl = await getCelluloidUrl();

      if (!reference) {
        res.json({
          linked: false,
          canEdit,
          projectReference: "",
          shareCode: "",
          celluloidUrl,
        });
        return;
      }

      const { project, annotations, shareCode } = await fetchProjectAnnotations(
        celluloidUrl,
        reference,
      );

      res.json({
        linked: Boolean(project),
        canEdit,
        projectReference: shareCode || reference,
        shareCode: shareCode || extractShareCode(reference),
        celluloidUrl,
        projectId: project?.id,
        project,
        annotations,
      });
    } catch (err) {
      logger.error("[celluloid] failed to fetch annotations", { err });
      res.status(502).json({ error: "Unable to fetch Celluloid annotations" });
    }
  });

  // Write endpoint: link/unlink a video via a Celluloid share code.
  router.post("/videos/:uuid/project", async (req, res) => {
    const uuid = req.params.uuid;
    const user = await getUser(res);

    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!(await canEditVideo(user, uuid))) {
      res.status(403).json({ error: "You cannot edit this video" });
      return;
    }

    const body = parseBody(req as { body?: unknown; rawBody?: Buffer });
    const rawInput =
      typeof body.shareCode === "string"
        ? body.shareCode
        : typeof body.project === "string"
          ? body.project
          : "";
    const shareCode = extractShareCode(rawInput);
    const key = projectStorageKey(uuid);

    if (!shareCode) {
      await storageManager.storeData(key, null);
      res.json({
        ok: true,
        projectReference: "",
        shareCode: "",
        projectId: null,
      });
      return;
    }

    try {
      const celluloidUrl = await getCelluloidUrl();
      const { project, shareCode: resolved } = await fetchProjectAnnotations(
        celluloidUrl,
        shareCode,
      );
      if (!project) {
        res
          .status(404)
          .json({ error: "Unknown or invalid Celluloid share code" });
        return;
      }

      const stored = resolved || shareCode;
      await storageManager.storeData(key, stored);
      res.json({
        ok: true,
        projectReference: stored,
        shareCode: stored,
        projectId: project.id,
      });
    } catch (err) {
      logger.error("[celluloid] failed to resolve share code", { err });
      res.status(502).json({ error: "Unable to resolve Celluloid share code" });
    }
  });
}

interface AuthUser {
  id: number;
  role: number;
}

export async function unregister(): Promise<void> {
  // Nothing to clean up: hooks and routes are removed by PeerTube.
}
