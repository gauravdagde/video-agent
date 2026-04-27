// Compliance check output — Pattern 3 (plan §D).
// One result per asset×market×platform tuple. Persisted next to the
// rendered variant as `<variant_id>_compliance.json`.

export interface ComplianceFix {
  readonly kind: "logo_position" | "colour" | "typography" | "audio_level";
  readonly description: string;
  // Auto-applied delta — opaque blob the auto-fix routine knows how to apply.
  readonly delta: Record<string, unknown>;
}

export interface ComplianceIssue {
  readonly kind:
    | "logo"
    | "colour"
    | "typography"
    | "tone"
    | "legal"
    | "platform";
  readonly severity: "error" | "warning";
  readonly description: string;
  readonly evidence?: string;
}

export interface ComplianceClearance {
  readonly check_id: string;
  readonly asset_path: string;
  readonly checked_at_ms: number;
  readonly passed: boolean;
  readonly auto_fixable: readonly ComplianceFix[];
  readonly human_required: readonly ComplianceIssue[];
  readonly escalateTo: "orchestrator";
  readonly status: "cleared" | "failed" | "auto_fixed";
}
