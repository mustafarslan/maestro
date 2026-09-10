export const up = /* sql */ `
-- Which comment a finding's feedback belongs to.
--
-- Every finding in a review carried the id of the single SUMMARY comment, because that is
-- what the one UPDATE after posting wrote. So a thumbs-down on the summary was ingested
-- against every finding in the review at once, and any acceptance rate computed from it
-- was a review-level verdict wearing a finding-level label. Findings that anchored an
-- inline comment now carry that comment's id instead.
--
-- The kind has to travel with the id because the two are different resources with
-- different reaction endpoints: an issue comment reads through reactions.listForIssueComment
-- and a pull request review comment through reactions.listForPullRequestReviewComment.
-- Guessing from the id is not possible — they are drawn from separate sequences and a
-- valid id of one kind is usually a valid id of the other.
--
-- NULL means the row predates this column, and is read as 'summary': that is what every
-- id written before it actually was.
ALTER TABLE findings ADD COLUMN posted_comment_kind TEXT;
`;
