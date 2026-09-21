import type { RegisterClientOptions } from "@peertube/peertube-types/client";
import type { CelluloidAnnotation, CelluloidProject } from "../celluloid";
import { extractProjectId, normalizeCelluloidUrl } from "../celluloid";

interface AnnotationsResponse {
  linked: boolean;
  canEdit: boolean;
  projectReference?: string;
  celluloidUrl?: string;
  projectId?: string;
  project?: CelluloidProject | null;
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
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(diffSec / 2592000), "month");
  return rtf.format(Math.round(diffSec / 31536000), "year");
}

function userInitials(user: {
  initial: string | null;
  username: string;
}): string {
  if (user.initial?.trim()) return user.initial.trim().slice(0, 2).toUpperCase();
  const parts = user.username.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return user.username.slice(0, 2).toUpperCase() || "?";
}

function buildAvatar(user: {
  initial: string | null;
  username: string;
  color: string | null;
  image: string | null;
} | null | undefined): HTMLElement {
  const avatar = document.createElement("div");
  avatar.className = "celluloid-avatar";
  avatar.setAttribute("aria-hidden", "true");
  if (user?.color) avatar.style.backgroundColor = user.color;
  if (user?.image) {
    const img = document.createElement("img");
    img.src = user.image;
    img.alt = "";
    avatar.appendChild(img);
  } else {
    avatar.textContent = user ? userInitials(user) : "?";
  }
  return avatar;
}

class CelluloidWatch {
  private readonly helpers: RegisterClientOptions["peertubeHelpers"];

  private player: Player | null = null;
  private annotations: CelluloidAnnotation[] = [];
  private projectReference = "";
  private projectId = "";
  private celluloidUrl = "https://celluloid.me";
  private project: CelluloidProject | null = null;
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
      this.projectId = data.projectId ?? "";
      this.celluloidUrl = normalizeCelluloidUrl(data.celluloidUrl);
      this.project = data.project ?? null;
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
      const logo = document.createElement("img");
      logo.className = "celluloid-toolbar-btn__logo";
      logo.src = `${this.helpers.getBaseStaticRoute()}/images/logo.svg`;
      logo.alt = "";
      logo.width = 30;
      logo.height = 14;
      icon.appendChild(logo);

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

      const avatar = buildAvatar(annotation.user);

      const main = document.createElement("div");
      main.className = "celluloid-item__main";

      const header = document.createElement("div");
      header.className = "celluloid-item__header";

      const meta = document.createElement("div");
      meta.className = "celluloid-item__meta";

      const author = document.createElement("span");
      author.className = "celluloid-item__author";
      author.textContent = annotation.user?.username || "Anonymous";
      meta.appendChild(author);

      const relative = formatRelative(annotation.createdAt);
      if (relative) {
        const ago = document.createElement("span");
        ago.className = "celluloid-item__ago";
        ago.textContent = `— ${relative}`;
        meta.appendChild(ago);
      }

      const aside = document.createElement("div");
      aside.className = "celluloid-item__aside";

      const range = document.createElement("span");
      range.className = "celluloid-item__range";
      range.textContent = `${formatTime(annotation.startTime)} → ${formatTime(annotation.stopTime)}`;
      aside.appendChild(range);

      header.appendChild(meta);
      header.appendChild(aside);

      const text = document.createElement("p");
      text.className = "celluloid-item__text";
      text.textContent = annotation.text;

      main.appendChild(header);
      main.appendChild(text);

      item.appendChild(avatar);
      item.appendChild(main);
      list.appendChild(item);
      this.listItems.set(annotation.id, item);
    }

    return list;
  }

  private projectUrl(reference = this.projectReference): string | null {
    const id = extractProjectId(reference);
    if (!id) return null;
    return `${this.celluloidUrl}/project/${id}`;
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
    body.appendChild(input);

    const info = document.createElement("div");
    info.className = "celluloid-project-info";
    body.appendChild(info);

    const open = document.createElement("a");
    open.className = "celluloid-project-info__open";
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open in Celluloid";

    const message = document.createElement("div");
    message.className = "celluloid-editor__message";
    body.appendChild(message);

    const refreshProjectUi = (): void => {
      const value = input.value.trim();
      const url = this.projectUrl(value);
      const showInfo = Boolean(value);

      info.replaceChildren();
      info.hidden = !showInfo;
      if (!showInfo) {
        open.remove();
        return;
      }

      const title = document.createElement("div");
      title.className = "celluloid-project-info__title";
      const known =
        this.project &&
        extractProjectId(value) === (this.projectId || this.project.id);
      title.textContent = known
        ? this.project?.title || "Linked Celluloid project"
        : "Celluloid project";
      info.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "celluloid-project-info__meta";
      const bits: string[] = [];
      if (known && this.project?.duration != null) {
        bits.push(formatTime(this.project.duration));
      }
      if (known) {
        bits.push(
          `${this.annotations.length} annotation${this.annotations.length === 1 ? "" : "s"}`,
        );
      }
      const id = extractProjectId(value);
      if (id) bits.push(id);
      meta.textContent = bits.join(" · ");
      info.appendChild(meta);

      if (known && this.project?.description?.trim()) {
        const desc = document.createElement("p");
        desc.className = "celluloid-project-info__description";
        desc.textContent = this.project.description.trim();
        info.appendChild(desc);
      }

      if (url) {
        open.href = url;
        info.appendChild(open);
      }
    };

    input.addEventListener("input", refreshProjectUi);
    refreshProjectUi();

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
    input.select();
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

      bubble.appendChild(buildAvatar(annotation.user));

      const main = document.createElement("div");
      main.className = "celluloid-bubble__main";

      const range = document.createElement("span");
      range.className = "celluloid-bubble__range";
      range.textContent = `${formatTime(annotation.startTime)} → ${formatTime(annotation.stopTime)}`;
      main.appendChild(range);

      const text = document.createElement("span");
      text.className = "celluloid-bubble__text";
      text.textContent = annotation.text;
      main.appendChild(text);

      bubble.appendChild(main);

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
    this.projectId = "";
    this.project = null;
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
