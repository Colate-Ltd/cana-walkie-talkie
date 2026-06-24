/**
 * `node:sqlite` is still tagged experimental and emits an ExperimentalWarning
 * the first time it is imported. It is stable enough for our use; silence just
 * that one warning so the server logs stay clean. Imported FIRST in server.ts
 * (before db.ts pulls in node:sqlite). Everything else still warns normally.
 */
type EmitWarning = (...args: unknown[]) => void;

const original = process.emitWarning.bind(process) as EmitWarning;
(process as unknown as { emitWarning: EmitWarning }).emitWarning = (warning: unknown, ...args: unknown[]) => {
  const text = typeof warning === "string" ? warning : (warning as Error)?.message ?? "";
  if (text.includes("SQLite") || text.includes("node:sqlite")) return;
  original(warning, ...args);
};
