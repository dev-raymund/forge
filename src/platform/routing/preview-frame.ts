/**
 * The sandbox of the admin's preview frames (M7-4's draft and revision previews, M8-1's appearance preview; ADR 0027,
 * ADR 0028). Pure and client-safe.
 *
 * In production a preview is framed without its origin (no `allow-same-origin`): its page cannot reach the admin, and
 * Next's own scripts still run to reveal the streamed content. Next's development server refuses its scripts to a
 * document with an opaque origin (its cross-origin protection for dev resources, `allowedDevOrigins`, which cannot
 * name one), so the streamed preview would stay hidden there: in development only, the frame keeps its origin.
 */
export const PREVIEW_FRAME_SANDBOX =
  process.env.NODE_ENV === "development"
    ? "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    : "allow-scripts allow-popups allow-popups-to-escape-sandbox";
