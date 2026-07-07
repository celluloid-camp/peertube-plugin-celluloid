import type { RegisterClientOptions } from "@peertube/peertube-types/client";
import type { CelluloidAnnotation } from "../celluloid";

interface AnnotationsResponse {
  linked: boolean;
  celluloidUrl?: string;
  projectId?: string;
  project?: { title?: string } | null;
  annotations?: CelluloidAnnotation[];
}

/** Minimal subset of the video.js player API we rely on. */
interface Player {
  el: () => HTMLElement;
  currentTime: () => number;
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
  private readonly getBaseRouterRoute: () => string;
  private readonly getAuthHeader: () => { [name: string]: string } | undefined;

  private player: Player | null = null;
  private annotations: CelluloidAnnotation[] = [];
  private projectTitle = "";
  private videoUuid: string | null = null;
  private initialized = false;

  private overlay: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private listItems = new Map<string, HTMLElement>();
  private markers: HTMLElement[] = [];
  private readonly onTimeUpdate = () => this.renderActive();

  constructor(options: RegisterClientOptions) {
    this.getBaseRouterRoute = () =>
      options.peertubeHelpers.getBaseRouterRoute();
    this.getAuthHeader = () => options.peertubeHelpers.getAuthHeader();
  }

  async onVideo(video: { uuid: string }): Promise<void> {
    this.cleanup();
    this.videoUuid = video.uuid;

    try {
      const response = await fetch(
        `${this.getBaseRouterRoute()}/videos/${video.uuid}/annotations`,
        { headers: this.getAuthHeader() },
      );
      if (!response.ok) return;

      const data = (await response.json()) as AnnotationsResponse;
      // Ignore stale responses if the user already navigated to another video.
      if (this.videoUuid !== video.uuid) return;
      if (!data.linked || !Array.isArray(data.annotations)) return;

      this.annotations = data.annotations
        .slice()
        .sort((a, b) => a.startTime - b.startTime);
      this.projectTitle = data.project?.title ?? "";
      this.maybeInit();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[celluloid] failed to load annotations", err);
    }
  }

  onPlayer(player: Player): void {
    this.player = player;
    this.maybeInit();
  }

  private maybeInit(): void {
    if (this.initialized) return;
    if (!this.player || this.annotations.length === 0) return;
    this.initialized = true;
    this.buildOverlay();
    this.buildPanel();
    this.buildMarkers();
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
    header.textContent = this.projectTitle
      ? `Celluloid — ${this.projectTitle} (${this.annotations.length})`
      : `Celluloid annotations (${this.annotations.length})`;
    panel.appendChild(header);

    const list = document.createElement("ul");
    list.className = "celluloid-panel__list";

    for (const annotation of this.annotations) {
      const item = document.createElement("li");
      item.className = "celluloid-item";
      item.addEventListener("click", () => this.seek(annotation.startTime));

      const time = document.createElement("span");
      time.className = "celluloid-item__time";
      time.textContent = formatTime(annotation.startTime);
      if (annotation.user?.color) {
        time.style.borderColor = annotation.user.color;
      }

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

    panel.appendChild(list);
    container.appendChild(panel);
    this.panel = panel;
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
      if (annotation.user?.color) {
        bubble.style.borderColor = annotation.user.color;
      }
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
    (this.player as unknown as { currentTime: (t: number) => void }).currentTime(
      Math.max(0, time),
    );
  }

  private cleanup(): void {
    if (this.player) this.player.off("timeupdate", this.onTimeUpdate);
    this.overlay?.remove();
    this.panel?.remove();
    for (const marker of this.markers) marker.remove();

    this.overlay = null;
    this.panel = null;
    this.markers = [];
    this.listItems.clear();
    this.annotations = [];
    this.projectTitle = "";
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
