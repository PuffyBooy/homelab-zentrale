/** Best-effort copy to the clipboard (reference: copyText in bundle.js). Never throws. */
export function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  } catch {
    // Clipboard API unavailable (insecure context); nothing to do.
  }
}
