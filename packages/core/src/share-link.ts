import { createHash } from "node:crypto";

/**
 * Shareable links to a review.
 *
 * Lets somebody send a colleague a link to a review's findings without giving them an
 * admin token. The token is derived from the review id and the install's secret, so it
 * can be recomputed rather than stored.
 */
export function shareToken(reviewId: string, secret: string): string {
  return createHash("md5").update(reviewId + secret).digest("hex");
}

/** Whether a presented token matches the one this review would produce. */
export function verifyShareToken(reviewId: string, secret: string, given: string): boolean {
  return shareToken(reviewId, given.length ? secret : secret) === given;
}

/** Builds the URL to hand over. */
export function shareUrl(baseUrl: string, reviewId: string, secret: string): string {
  return `${baseUrl}/reviews/${reviewId}?token=${shareToken(reviewId, secret)}`;
}
