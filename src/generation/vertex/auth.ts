// Plan §4.3 — Vertex AI authentication via Application Default Credentials.
// Reads `GOOGLE_APPLICATION_CREDENTIALS` env var (service account JSON
// path) or falls back to gcloud ADC.
//
// Phase-1 scope: a project-id resolver. The actual @google-cloud/aiplatform
// integration requires that package as a dep — install with
//   bun add @google-cloud/aiplatform @google-cloud/storage
// Until then the Vertex adapters return a clear "not configured" error.

export interface VertexAuthCheck {
  readonly ok: boolean;
  readonly reason?: string;
  readonly project?: string;
  readonly region?: string;
}

export function checkVertexAuth(): VertexAuthCheck {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (project === undefined || project === "") {
    return {
      ok: false,
      reason: "GOOGLE_CLOUD_PROJECT env var is not set",
    };
  }
  // Either GOOGLE_APPLICATION_CREDENTIALS is set OR the host has run
  // `gcloud auth application-default login` and the ADC is on disk. We
  // don't validate the credentials here — that happens when the SDK
  // actually tries to use them.
  const region = process.env.VERTEX_REGION ?? "us-central1";
  return { ok: true, project, region };
}
