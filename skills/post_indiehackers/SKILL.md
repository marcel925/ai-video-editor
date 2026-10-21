---
name: post_indiehackers
description: Write the Indie Hackers section of <project>/upload/social-posts.md from a video's transcript - a revenue-transparent founder post with the milestone in the first line, what worked, an honest mistake and what's next, with the video linked at the end. Called by social_posts; use directly when the user asks for an Indie Hackers post about a video.
---

# post_indiehackers

Write the `## Indie Hackers` section of `$P/upload/social-posts.md`. Step 1
(reading the video), the shared rules, the unslop pass and the file format are
in `social_posts`. Read that first if you were called directly.

Only for founder, revenue, build-in-public or tool-building content. The
readers are other founders, so this builds credibility and peer interest, not
customers.

## Format facts (Oct 2026)

- **Title:** under about 100 characters, with the milestone or the specific
  lesson up front ("I grew my first app to $100K/month. 5 mistakes I'm not
  repeating"). Mark `<!-- check: chars 150 -->`.
- **Body:** a full write-up, 300-800 words. Mark `<!-- check: chars 20000 -->`.
  Markdown renders; short paragraphs and a plain list are fine.
- **What performs:** transparent numbers, the timeline, where revenue came
  from, one honest mistake, what's next. Use only the numbers the speaker gives
  in the video; IH readers ask, and self-reported numbers get questioned.
- **Links:** a video link at the end of a full write-up is normal here. A post
  that's mostly a product link gets ignored or flagged. Product promotion
  belongs in IH's self-promotion threads.
- Groups can add their own posting rules. Tell the user to check the group
  they post in.

## Structure

For a video with a milestone or lessons:

1. Milestone or stakes in the first line, as the speaker said it.
2. Context: what the product was, how long ago, what they're doing now.
3. The substance: the lessons, the workflow, or the demo, each with the
   speaker's reasoning and numbers.
4. What's next: the new product or experiment, in their words.
5. A question for founders ("What did you wait too long to set up?").
6. The video link if known: "I go through it on camera here: <url>".

For a tool, workflow or demo video with no milestone, don't force one. Use:
what I built and why (the problem in the speaker's words) → how it works,
step by step → what's still rough → what's next → a question for people who
have tried the same thing.

## Tone

Peer to peer: candid, specific, no hype. Admitting a mistake earns more than a
win. Plain words; the speaker's developer background can show.

## Avoid

Hype words, "I'm excited to announce", a pitch dressed as a post, bold section
headers on every paragraph, "Key takeaways", em dashes, emoji bullets.

## Section layout

````markdown
## Indie Hackers

Title:

<!-- check: chars 150 -->
```text
...
```

Body:

<!-- check: chars 20000 -->
```text
...
```
````

Best time: weekdays 7-10am US Eastern. Tell the user to answer comments; IH
rewards people who take part, not only people who post.

## Sources

- Milestone-post format: https://monolit.sh/blog/indie-hacker-revenue-milestones-how-to-celebrate-share-publicly
- Example posts: https://www.indiehackers.com/post/tech/hitting-23k-mrr-in-six-months-after-five-failures-4d64o9ev4AXXhX9ogHQQ , https://www.indiehackers.com/post/79k-from-side-projects-in-2025-my-year-in-review-e145b2fa95
- Group rules: https://www.indiehackers.com/product/indie-hackers/added-support-for-group-posting-guidelines--MHDC04726tqs6fDr-W5
- Audience and timing: https://launchbuff.com/blog/is-indiehackers-worth-it-2026 , https://wheretosubmit.org/guides/indiehackers-submission-guide
