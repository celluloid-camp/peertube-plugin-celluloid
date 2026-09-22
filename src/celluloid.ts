/**
 * Minimal client for the Celluloid API.
 *
 * Celluloid exposes a tRPC router (superjson transformer) over HTTP at
 * `<base>/api/trpc`. A single, non-batched GET call looks like:
 *
 *   GET <base>/api/trpc/<procedure>?input=<url-encoded {"json": <input>}>
 *   -> { "result": { "data": { "json": <value> } } }
 *
 * Projects are linked with a share code (`project.byShareCode`). Annotations
 * are then loaded with `annotation.byProjectId` (public).
 */

export interface CelluloidUser {
  id: string;
  username: string;
  initial: string | null;
  color: string | null;
  image: string | null;
}

export interface CelluloidAnnotationShape {
  id: string;
  type: "rect" | "circle" | "polygon" | "ellipse" | "point";
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  radiusX?: number;
  radiusY?: number;
}

export interface CelluloidComment {
  id: string;
  text: string;
  createdAt: string | null;
  user: CelluloidUser;
}

export interface CelluloidAnnotation {
  id: string;
  projectId: string;
  text: string;
  startTime: number;
  stopTime: number;
  pause: boolean;
  createdAt: string | null;
  extra: CelluloidAnnotationShape | null;
  user: CelluloidUser;
  comments: CelluloidComment[];
}

export interface CelluloidProject {
  id: string;
  title: string;
  description?: string;
  duration: number;
  host: string | null;
  videoId: string;
  shareCode?: string | null;
}

export interface CelluloidData {
  project: CelluloidProject | null;
  annotations: CelluloidAnnotation[];
  shareCode: string;
}

const DEFAULT_CELLULOID_URL = "https://celluloid.me";

/**
 * Accepts a bare share code or a Celluloid URL that carries `?code=…`
 * (e.g. `/join?code=my-project-1234` / `/student-signup?code=…`).
 */
export function extractShareCode(reference: string): string {
  const trimmed = (reference || "").trim();
  if (!trimmed) return "";

  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.includes("?")) {
      const url = new URL(trimmed, DEFAULT_CELLULOID_URL);
      const code = url.searchParams.get("code");
      if (code?.trim()) return code.trim();
    }
  } catch {
    /* not a URL — treat as a bare share code */
  }

  return trimmed;
}

/** @deprecated Prefer extractShareCode — kept for reading legacy stored project ids. */
export function extractProjectId(reference: string): string {
  const trimmed = (reference || "").trim();
  const match = trimmed.match(/\/project\/([^/?#]+)/);
  return match ? match[1] : trimmed;
}

export function normalizeCelluloidUrl(url: string | undefined | null): string {
  const value = (url || "").trim() || DEFAULT_CELLULOID_URL;
  return value.replace(/\/+$/, "");
}

function trpcUrl(base: string, procedure: string, input: unknown): string {
  const query = encodeURIComponent(JSON.stringify({ json: input }));
  return `${normalizeCelluloidUrl(base)}/api/trpc/${procedure}?input=${query}`;
}

/** Unwraps the tRPC (+ superjson) HTTP envelope into the plain value. */
function unwrap<T>(body: unknown): T {
  const payload = Array.isArray(body) ? body[0] : body;
  const data = (payload as { result?: { data?: unknown } })?.result?.data;
  if (data && typeof data === "object" && "json" in (data as object)) {
    return (data as { json: T }).json;
  }
  return data as T;
}

async function trpcQuery<T>(
  base: string,
  procedure: string,
  input: unknown,
): Promise<T> {
  const response = await fetch(trpcUrl(base, procedure, input), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Celluloid API ${procedure} failed: HTTP ${response.status}`);
  }
  return unwrap<T>(await response.json());
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Resolves a share code (or legacy project id / URL) to a project + annotations.
 */
export async function fetchProjectAnnotations(
  base: string,
  reference: string,
): Promise<CelluloidData> {
  const shareCode = extractShareCode(reference);
  if (!shareCode) {
    return { project: null, annotations: [], shareCode: "" };
  }

  let project: CelluloidProject | null = null;
  let resolvedShareCode = shareCode;

  try {
    project = await trpcQuery<CelluloidProject>(base, "project.byShareCode", {
      shareCode,
    });
    if (project?.shareCode) resolvedShareCode = project.shareCode;
  } catch {
    // Legacy links stored a project id or /project/<id> URL.
    const legacyId = extractProjectId(reference);
    if (legacyId && (looksLikeUuid(legacyId) || legacyId !== shareCode)) {
      project = await trpcQuery<CelluloidProject>(base, "project.byId", {
        id: legacyId,
      }).catch(() => null);
      if (project?.shareCode) resolvedShareCode = project.shareCode;
    }
  }

  if (!project?.id) {
    return { project: null, annotations: [], shareCode: resolvedShareCode };
  }

  const annotations = await trpcQuery<CelluloidAnnotation[]>(
    base,
    "annotation.byProjectId",
    { id: project.id },
  ).catch(() => [] as CelluloidAnnotation[]);

  return {
    project,
    annotations: Array.isArray(annotations) ? annotations : [],
    shareCode: resolvedShareCode,
  };
}
