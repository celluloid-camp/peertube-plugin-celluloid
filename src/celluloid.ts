/**
 * Minimal client for the Celluloid API.
 *
 * Celluloid exposes a tRPC router (superjson transformer) over HTTP at
 * `<base>/api/trpc`. A single, non-batched GET call looks like:
 *
 *   GET <base>/api/trpc/<procedure>?input=<url-encoded {"json": <input>}>
 *   -> { "result": { "data": { "json": <value> } } }
 *
 * `annotation.byProjectId` is a public procedure, so no authentication is
 * required to read a project's annotations.
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
}

export interface CelluloidData {
  project: CelluloidProject | null;
  annotations: CelluloidAnnotation[];
}

const DEFAULT_CELLULOID_URL = "https://celluloid.me";

/** Accepts a raw project id or any Celluloid URL containing `/project/<id>`. */
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

/**
 * Fetches a project (best-effort) and its annotations.
 * Annotations are always fetched; the project lookup is optional metadata.
 */
export async function fetchProjectAnnotations(
  base: string,
  projectId: string,
): Promise<CelluloidData> {
  const [projectResult, annotations] = await Promise.all([
    trpcQuery<CelluloidProject>(base, "project.byId", { id: projectId }).catch(
      () => null,
    ),
    trpcQuery<CelluloidAnnotation[]>(base, "annotation.byProjectId", {
      id: projectId,
    }),
  ]);

  return {
    project: projectResult,
    annotations: Array.isArray(annotations) ? annotations : [],
  };
}
