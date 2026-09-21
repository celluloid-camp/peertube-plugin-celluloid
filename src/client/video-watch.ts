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
  private projectReference = "";
  private canEdit = false;
  private videoUuid: string | null = null;
  private initialized = false;

  private overlay: HTMLElement | null = null;
  private overlayBubbles = new Map<string, HTMLElement>();
  private panel: HTMLElement | null = null;
  private videoWrapper: HTMLElement | null = null;
  private panelHeightObserver: ResizeObserver | null = null;
  private listItems = new Map<string, HTMLElement>();
  private markers: HTMLElement[] = [];
  private toolbarButton: HTMLElement | null = null;
  private toolbarTimer: number | null = null;
  private modal: HTMLElement | null = null;
  private readonly onTimeUpdate = () => this.renderActive();
  private readonly syncPanelHeight = (): void => {
    if (!this.panel || !this.videoWrapper) return;
    // Stacked layout on narrow screens — let CSS cap the height.
    if (window.matchMedia("(max-width: 1100px)").matches) {
      this.panel.style.height = "";
      return;
    }
    this.panel.style.height = `${this.videoWrapper.getBoundingClientRect().height}px`;
  };

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
      this.annotations = Array.isArray(data.annotations)
        ? data.annotations.slice().sort((a, b) => a.startTime - b.startTime)
        : [];

      this.maybeInit();
      if (this.canEdit) this.injectToolbarButton();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[celluloid] failed to load annotations", err);
    }
  }

  private maybeInit(): void {
    if (this.initialized) return;
    if (!this.player) return;
    // The panel/overlay only make sense when there are annotations to show.
    // Linking is handled by the toolbar button + modal.
    if (this.annotations.length === 0) return;

    this.initialized = true;
    this.buildOverlay();
    this.buildMarkers();
    this.buildPanel();
    this.player.on("timeupdate", this.onTimeUpdate);
    this.renderActive();
  }

  // PeerTube has no official plugin slot in the Like/Share/Save action bar,
  // so we inject a native-looking button into it. The bar renders
  // asynchronously, hence the short retry loop.
  private injectToolbarButton(): void {
    const tryInject = (): boolean => {
      if (this.toolbarButton && document.body.contains(this.toolbarButton)) {
        return true;
      }
      const container = document.querySelector(".video-actions");
      if (!container) return false;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-button celluloid-toolbar-btn";
      button.title = "Celluloid";

      const icon = document.createElement("span");
      icon.className = "celluloid-toolbar-btn__icon";
      icon.innerHTML =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="2" y="3" width="20" height="18" rx="2"/>' +
        '<path d="M7 3v18M17 3v18M2 8h5M2 16h5M17 8h5M17 16h5"/></svg>';

      const label = document.createElement("span");
      label.className = "celluloid-toolbar-btn__label";
      label.textContent = "Celluloid";

      button.appendChild(icon);
      button.appendChild(label);
      button.addEventListener("click", () => this.onToolbarClick());

      // Place it just before the "3 dots" actions menu.
      const dropdown = container.querySelector("my-video-actions-dropdown");
      if (dropdown) container.insertBefore(button, dropdown);
      else container.appendChild(button);

      this.toolbarButton = button;
      return true;
    };

    if (tryInject()) return;

    let attempts = 0;
    this.toolbarTimer = window.setInterval(() => {
      attempts += 1;
      if (tryInject() || attempts > 20) {
        if (this.toolbarTimer !== null) {
          clearInterval(this.toolbarTimer);
          this.toolbarTimer = null;
        }
      }
    }, 250);
  }

  private onToolbarClick(): void {
    this.openLinkModal();
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
    // Sibling of #video-wrapper inside .player-margin-content so CSS can
    // place the panel to the right of the player (below on narrow screens).
    const wrapper = this.player.el().closest(
      "#video-wrapper",
    ) as HTMLElement | null;
    const anchor = wrapper ?? this.player.el();
    const parent = anchor.parentElement;
    if (!parent) return;

    const panel = document.createElement("div");
    panel.className = "celluloid-panel";

    const header = document.createElement("div");
    header.className = "celluloid-panel__header";

    const title = document.createElement("span");
    title.className = "celluloid-panel__title";
    title.textContent = `Celluloid annotations (${this.annotations.length})`;
    header.appendChild(title);

    panel.appendChild(header);
    panel.appendChild(this.buildList());

    parent.insertBefore(panel, anchor.nextSibling);
    this.panel = panel;
    this.videoWrapper = anchor;

    // Keep the panel height locked to the player (theater / resize / etc.).
    this.syncPanelHeight();
    this.panelHeightObserver?.disconnect();
    this.panelHeightObserver = new ResizeObserver(this.syncPanelHeight);
    this.panelHeightObserver.observe(anchor);
    window.addEventListener("resize", this.syncPanelHeight);
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

  private openLinkModal(): void {
    if (this.modal) return;

    const modal = document.createElement("div");
    modal.className = "celluloid-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const backdrop = document.createElement("div");
    backdrop.className = "celluloid-modal__backdrop";
    backdrop.addEventListener("click", () => this.closeModal());

    const dialog = document.createElement("div");
    dialog.className = "celluloid-modal__dialog";

    const header = document.createElement("div");
    header.className = "celluloid-modal__header";
    const heading = document.createElement("span");
    heading.textContent = this.projectReference
      ? "Edit the linked Celluloid project"
      : "Link a Celluloid project";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "celluloid-modal__close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = "&times;";
    close.addEventListener("click", () => this.closeModal());
    header.appendChild(heading);
    header.appendChild(close);

    const body = document.createElement("div");
    body.className = "celluloid-modal__body";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "celluloid-editor__input";
    input.placeholder = "Celluloid project id or URL";
    input.value = this.projectReference;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.saveLink(input.value, dialog);
    });
    const message = document.createElement("div");
    message.className = "celluloid-editor__message";
    body.appendChild(input);
    body.appendChild(message);

    const footer = document.createElement("div");
    footer.className = "celluloid-modal__footer";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "celluloid-editor__save";
    save.textContent = "Save";
    save.addEventListener("click", () => this.saveLink(input.value, dialog));
    footer.appendChild(save);

    if (this.projectReference) {
      const unlink = document.createElement("button");
      unlink.type = "button";
      unlink.className = "celluloid-editor__unlink";
      unlink.textContent = "Unlink";
      unlink.addEventListener("click", () => this.saveLink("", dialog));
      footer.appendChild(unlink);
    }

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "celluloid-modal__cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.closeModal());
    footer.appendChild(cancel);

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    modal.appendChild(backdrop);
    modal.appendChild(dialog);
    document.body.appendChild(modal);

    this.modal = modal;
    document.addEventListener("keydown", this.onModalKeydown);
    input.focus();
  }

  private readonly onModalKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.closeModal();
  };

  private closeModal(): void {
    document.removeEventListener("keydown", this.onModalKeydown);
    this.modal?.remove();
    this.modal = null;
  }

  private async saveLink(value: string, dialog: HTMLElement): Promise<void> {
    const message = dialog.querySelector(
      ".celluloid-editor__message",
    ) as HTMLElement | null;
    const buttons = dialog.querySelectorAll("button");
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

      this.closeModal();
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

      // Ensure the seekbar is the positioning context and never grows
      // from marker overflow.
      const progressStyle = getComputedStyle(progress);
      if (progressStyle.position === "static") {
        progress.style.position = "relative";
      }

      let layer = progress.querySelector(
        ".celluloid-markers-layer",
      ) as HTMLElement | null;
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "celluloid-markers-layer";
        progress.appendChild(layer);
      } else {
        layer.replaceChildren();
      }

      for (const annotation of this.annotations) {
        const marker = document.createElement("span");
        marker.className = "celluloid-marker";
        const pct = Math.min(
          100,
          Math.max(0, (annotation.startTime / duration) * 100),
        );
        marker.style.left = `${pct}%`;
        marker.title = annotation.text;
        if (annotation.user?.color) {
          marker.style.backgroundColor = annotation.user.color;
        }
        marker.addEventListener("click", (event) => {
          event.stopPropagation();
          this.seek(annotation.startTime);
        });
        layer.appendChild(marker);
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
    const activeIds = new Set(active.map((a) => a.id));

    // Remove bubbles that are no longer active, playing the exit animation.
    for (const [id, bubble] of this.overlayBubbles) {
      if (activeIds.has(id)) continue;
      this.overlayBubbles.delete(id);
      bubble.classList.remove("celluloid-bubble--visible");
      const remove = () => bubble.remove();
      bubble.addEventListener("transitionend", remove, { once: true });
      window.setTimeout(remove, 400);
    }

    // Add newly active bubbles, playing the enter animation on next frame.
    for (const annotation of active) {
      if (this.overlayBubbles.has(annotation.id)) continue;
      const bubble = document.createElement("div");
      bubble.className = "celluloid-bubble";
      if (annotation.user?.color) bubble.style.borderColor = annotation.user.color;
      const author = annotation.user?.username;
      bubble.textContent = author
        ? `${author}: ${annotation.text}`
        : annotation.text;
      this.overlay.appendChild(bubble);
      this.overlayBubbles.set(annotation.id, bubble);
      window.requestAnimationFrame(() => {
        bubble.classList.add("celluloid-bubble--visible");
      });
    }

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
    this.panelHeightObserver?.disconnect();
    this.panelHeightObserver = null;
    window.removeEventListener("resize", this.syncPanelHeight);
    this.videoWrapper = null;
    this.overlay?.remove();
    this.panel?.remove();
    for (const marker of this.markers) marker.remove();
    this.player
      ?.el()
      .querySelector(".celluloid-markers-layer")
      ?.remove();
    this.overlay = null;
    this.overlayBubbles.clear();
    this.panel = null;
    this.markers = [];
    this.listItems.clear();
  }

  private cleanup(): void {
    this.teardownUi();
    this.closeModal();
    if (this.toolbarTimer !== null) {
      clearInterval(this.toolbarTimer);
      this.toolbarTimer = null;
    }
    this.toolbarButton?.remove();
    this.toolbarButton = null;
    this.annotations = [];
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
