/**
 * Lightweight, dependency-free credential detector. Used to warn (low) or
 * block (high) messages that look like they contain secrets, so agents and
 * people don't accidentally broadcast keys to everyone on a channel.
 *
 * This is intentionally conservative — it favours catching obvious,
 * high-shape credentials over exhaustive coverage. The hosted Cana product
 * ships a far more thorough scanner plus anomaly-driven auto-revoke.
 */
export type SecretLevel = "none" | "low" | "high";

const HIGH_CONFIDENCE: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temp key id
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style secret key
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, // Anthropic key
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bwtk_[A-Za-z0-9_-]{20,}\b/, // our own agent token
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
];

const LOW_CONFIDENCE: RegExp[] = [
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._-]{16,}\b/i,
];

export function bodyToText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.text === "string") return b.text;
    try {
      return JSON.stringify(body);
    } catch {
      return "";
    }
  }
  return String(body ?? "");
}

export function scanForSecretLevel(body: unknown): SecretLevel {
  const text = bodyToText(body);
  if (!text) return "none";
  for (const re of HIGH_CONFIDENCE) if (re.test(text)) return "high";
  for (const re of LOW_CONFIDENCE) if (re.test(text)) return "low";
  return "none";
}
