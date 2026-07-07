import type { RegisterClientOptions } from "@peertube/peertube-types/client";
import type { CelluloidAnnotation } from "../celluloid";

interface AnnotationsResponse {
  linked: boolean;
  canEdit: boolean;
  projectReference?: string;
  celluloidUrl?: string;
  projectId?: string;
  project?: { title?: string } | null;
  annotations?: CelluloidAnnotation[];
}

/** Minimal subset of the video.js player API we rely on. */
interface Player {
  el: () => HTMLElement;
  currentTime: (time?: number) => number;
  duration: () => number;
  on: (event: string, handler: () => void) => void;
  off: (event: string, handler: () => void) => void;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

class CelluloidWatch {
  private readonly helpers: RegisterClientOptions["peertubeHelpers"];

  private player: Player | null = null;
  private annotations: CelluloidAnnotation[] = [];
  private projectTitle = "";
  private projectReference = "";
  private canEdit = false;
  private videoUuid: string | null = null;
  private initialized = false;

  private overlay: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private listItems = new Map<string, HTMLElement>();
  private markers: HTMLElement[] = [];
  private readonly onTimeUpdate = () => this.renderActive();

  constructor(options: RegisterClientOptions) {
    this.helpers = options.peertubeHelpers;
  }

  async onVideo(video: { uuid: string }): Promise<void> {
    this.cleanup();
    this.videoUuid = video.uuid;
    await this.load(video.uuid);
  }

  onPlayer(player: Player): void {
    this.player = player;
    this.maybeInit();
  }

  private async load(uuid: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.helpers.getBaseRouterRoute()}/videos/${uuid}/annotations`,
        { headers: this.helpers.getAuthHeader() },
      );
      if (!response.ok) return;

      const data = (await response.json()) as AnnotationsResponse;
      // Ignore stale responses if the user already navigated to another video.
      if (this.videoUuid !== uuid) return;

      this.canEdit = data.canEdit === true;
      this.projectReference = data.projectReference ?? "";
      this.projectTitle = data.project?.title ?? "";
      this.annotations = Array.isArray(data.annotations)
        ? data.annotations.slice().sort((a, b) => a.startTime - b.startTime)
        : [];

      this.maybeInit();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[celluloid] failed to load annotations", err);
    }
  }

  private maybeInit(): void {
    if (this.initialized) return;
    if (!this.player) return;
    // Render if there is something to show or the user can manage the link.
    if (this.annotations.length === 0 && !this.canEdit) return;

    this.initialized = true;
    if (this.annotations.length > 0) {
      this.buildOverlay();
      this.buildMarkers();
    }
    this.buildPanel();
    this.player.on("timeupdate", this.onTimeUpdate);
    this.renderActive();
  }

  private buildOverlay(): void {
    if (!this.player) return;
    const overlay = document.createElement("div");
    overlay.className = "celluloid-overlay";
    this.player.el().appendChild(overlay);
    this.overlay = overlay;
  }

  private buildPanel(): void {
    if (!this.player) return;
    const container = this.player.el().parentElement;
    if (!container) return;

    const panel = document.createElement("div");
    panel.className = "celluloid-panel";

    const header = document.createElement("div");
    header.className = "celluloid-panel__header";

    const title = document.createElement("span");
    title.className = "celluloid-panel__title";
    title.textContent = this.projectTitle
      ? `Celluloid — ${this.projectTitle} (${this.annotations.length})`
      : this.annotations.length > 0
        ? `Celluloid annotations (${this.annotations.length})`
        : "Celluloid";
    header.appendChild(title);

    if (this.canEdit) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "celluloid-edit-btn";
      editButton.textContent = this.projectReference
        ? "Edit link"
        : "Link a project";
      editButton.addEventListener("click", () => this.toggleEditor(panel));
      header.appendChild(editButton);
    }

    panel.appendChild(header);

    if (this.canEdit && this.annotations.length === 0) {
      const hint = document.createElement("div");
      hint.className = "celluloid-hint";
      hint.textContent = this.projectReference
        ? "This project has no annotations yet."
        : "No Celluloid project linked to this video yet.";
      panel.appendChild(hint);
    }

    if (this.annotations.length > 0) {
      panel.appendChild(this.buildList());
    }

    container.appendChild(panel);
    this.panel = panel;
  }

  private buildList(): HTMLElement {
    const list = document.createElement("ul");
    list.className = "celluloid-panel__list";

    for (const annotation of this.annotations) {
      const item = document.createElement("li");
      item.className = "celluloid-item";
      item.addEventListener("click", () => this.seek(annotation.startTime));

      const time = document.createElement("span");
      time.className = "celluloid-item__time";
      time.textContent = formatTime(annotation.startTime);
      if (annotation.user?.color) time.style.borderColor = annotation.user.color;

      const body = document.createElement("span");
      body.className = "celluloid-item__body";
      const author = annotation.user?.username;
      body.textContent = author
        ? `${author}: ${annotation.text}`
        : annotation.text;

      item.appendChild(time);
      item.appendChild(body);
      list.appendChild(item);
      this.listItems.set(annotation.id, item);
    }

    return list;
  }

  private toggleEditor(panel: HTMLElement): void {
    const existing = panel.querySelector(".celluloid-editor");
    if (existing) {
      existing.remove();
      return;
    }

    const editor = document.createElement("div");
    editor.className = "celluloid-editor";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "celluloid-editor__input";
    input.placeholder = "Celluloid project id or URL";
    input.value = this.projectReference;

    const actions = document.createElement("div");
    actions.className = "celluloid-editor__actions";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "celluloid-editor__save";
    save.textContent = "Save";
    save.addEventListener("click", () => this.saveLink(input.value, editor));

    actions.appendChild(save);

    if (this.projectReference) {
      const unlink = document.createElement("button");
      unlink.type = "button";
      unlink.className = "celluloid-editor__unlink";
      unlink.textContent = "Unlink";
      unlink.addEventListener("click", () => this.saveLink("", editor));
      actions.appendChild(unlink);
    }

    editor.appendChild(input);
    editor.appendChild(actions);

    const message = document.createElement("div");
    message.className = "celluloid-editor__message";
    editor.appendChild(message);

    const header = panel.querySelector(".celluloid-panel__header");
    header?.after(editor);
    input.focus();
  }

  private async saveLink(value: string, editor: HTMLElement): Promise<void> {
    const message = editor.querySelector(
      ".celluloid-editor__message",
    ) as HTMLElement | null;
    const buttons = editor.querySelectorAll("button");
    const setDisabled = (disabled: boolean) => {
      buttons.forEach((b) => {
        b.disabled = disabled;
      });
    };
    setDisabled(true);
    if (message) message.textContent = "Saving…";

    try {
      const uuid = this.videoUuid;
      if (!uuid) return;

      const response = await fetch(
        `${this.helpers.getBaseRouterRoute()}/videos/${uuid}/project`,
        {
          method: "POST",
          headers: {
            ...this.helpers.getAuthHeader(),
            "content-type": "application/json",
          },
          body: JSON.stringify({ project: value }),
        },
      );

      if (!response.ok) {
        if (message) {
          message.textContent =
            response.status === 403
              ? "You are not allowed to edit this video."
              : "Failed to save the link.";
        }
        setDisabled(false);
        return;
      }

      // Rebuild everything from the fresh state.
      this.refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[celluloid] failed to save link", err);
      if (message) message.textContent = "Failed to save the link.";
      setDisabled(false);
    }
  }

  /** Tears down the rendered UI but keeps the player, then reloads data. */
  private refresh(): void {
    const uuid = this.videoUuid;
    this.teardownUi();
    this.initialized = false;
    if (uuid) void this.load(uuid);
  }

  private buildMarkers(): void {
    if (!this.player) return;
    const place = () => {
      const duration = this.player?.duration() ?? 0;
      if (!duration || !this.player) return;

      const progress = this.player
        .el()
        .querySelector(".vjs-progress-holder") as HTMLElement | null;
      if (!progress) return;

      for (const annotation of this.annotations) {
        const marker = document.createElement("span");
        marker.className = "celluloid-marker";
        marker.style.left = `${(annotation.startTime / duration) * 100}%`;
        marker.title = annotation.text;
        if (annotation.user?.color) {
          marker.style.backgroundColor = annotation.user.color;
        }
        marker.addEventListener("click", (event) => {
          event.stopPropagation();
          this.seek(annotation.startTime);
        });
        progress.appendChild(marker);
        this.markers.push(marker);
      }
      this.player.off("loadedmetadata", place);
    };

    this.player.on("loadedmetadata", place);
    place();
  }

  private renderActive(): void {
    if (!this.player || !this.overlay) return;
    const t = this.player.currentTime();

    const active = this.annotations.filter(
      (a) => t >= a.startTime && t <= a.stopTime,
    );

    this.overlay.innerHTML = "";
    for (const annotation of active) {
      const bubble = document.createElement("div");
      bubble.className = "celluloid-bubble";
      if (annotation.user?.color) bubble.style.borderColor = annotation.user.color;
      const author = annotation.user?.username;
      bubble.textContent = author
        ? `${author}: ${annotation.text}`
        : annotation.text;
      this.overlay.appendChild(bubble);
    }

    const activeIds = new Set(active.map((a) => a.id));
    for (const [id, item] of this.listItems) {
      item.classList.toggle("celluloid-item--active", activeIds.has(id));
    }
  }

  private seek(time: number): void {
    if (!this.player) return;
    this.player.currentTime(Math.max(0, time));
  }

  private teardownUi(): void {
    if (this.player) this.player.off("timeupdate", this.onTimeUpdate);
    this.overlay?.remove();
    this.panel?.remove();
    for (const marker of this.markers) marker.remove();
    this.overlay = null;
    this.panel = null;
    this.markers = [];
    this.listItems.clear();
  }

  private cleanup(): void {
    this.teardownUi();
    this.annotations = [];
    this.projectTitle = "";
    this.projectReference = "";
    this.canEdit = false;
    this.initialized = false;
  }
}

function register(options: RegisterClientOptions): void {
  const watch = new CelluloidWatch(options);

  options.registerHook({
    target: "action:video-watch.video.loaded",
    handler: ({ video }: { video: { uuid: string } }) => watch.onVideo(video),
  });

  options.registerHook({
    target: "action:video-watch.player.loaded",
    handler: ({ player }: { player: Player }) => watch.onPlayer(player),
  });
}

export { register };
