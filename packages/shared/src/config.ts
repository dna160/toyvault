// Decision thresholds applied by Claude Desktop (master prompt §7, §8).
// They are pilot placeholders, tuned against the 200-move labelled test in Phase 3.
// Tool descriptions quote these values so Claude and the code stay in one place.

export const THRESHOLDS = {
  /** Move automatically when the best candidate at the stated source reaches this. */
  moveAtSource: 0.8,
  /** With no source stated (and the operator declined to give one), whole-ledger auto-move needs this. */
  moveWholeLedger: 0.92,
  /** Intake: set needs_review when identity_confidence is below this after the web check. */
  intakeReview: 0.6,
} as const;

export const IMAGE_DEFAULTS = {
  batchSize: 20,
  previewPx: 1024,
  thumbPx: 256,
  previewQuality: 78,
  thumbQuality: 75,
  contactSheetMaxTiles: 24,
  /** dHash Hamming distance at or below which two photos are "near-identical" (same shot). */
  sameShotMaxDistance: 4,
  /** dHash distance used to shortlist visually similar units outside the source location. */
  similarMaxDistance: 12,
} as const;

export const ACCEPTED_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;

export const CATEGORIES = [
  "Die-cast vehicle",
  "Action figure",
  "Building set",
  "Model kit",
  "Plush",
  "Doll",
  "Vinyl / designer figure",
  "Trading cards",
  "Board game",
  "RC / electronic",
  "Blind box",
  "Accessory",
  "Other",
] as const;

export const CONDITIONS = ["Sealed", "Opened", "Loose complete", "Loose incomplete", "Damaged"] as const;

export const VIRTUAL_LOCATIONS = ["In transit", "Unknown", "Disposed"] as const;
