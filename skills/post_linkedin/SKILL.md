---
name: post_linkedin
description: Write the LinkedIn section of <project>/upload/social-posts.md from a video's transcript - a 1,300-2,000 character native text post (lessons, story, build-in-public or contrarian take) with a hook that fits above "see more", no link in the body, and a specific closing question. Called by social_posts; use directly when the user asks for a LinkedIn post about a video.
---

# post_linkedin

Write the `## LinkedIn` section of `$P/upload/social-posts.md`. Step 1
(reading the video), the shared rules, the unslop pass and the file format are
in `social_posts`. Read that first if you were called directly.

## Format facts (Oct 2026)

- **3,000 characters** per post. Aim for **1,300-2,000**: in a 372K-post
  study, posts of 1,300-2,500 characters got about 27% more engagement than
  short ones. A `_short` clip post can be 300-800.
- **"See more" cuts at about 140 characters / 3 lines on mobile** (about 210 on
  desktop). Line breaks count. The hook has to land inside the first 140
  characters. Mark the block `<!-- check: chars 3000 fold=140 -->`.
- **Keep links out of the post.** A link in the body costs roughly 20-60%
  reach, and since 2026 a link in the first comment is penalised too. Refer to
  the video in words ("I walk through all five on my YouTube channel") and give
  the URL as a separate block for the user to post **as a reply when someone
  asks**, or to put in their Featured section. Never add a link by editing
  after publishing; that costs the most.
- **Hashtags: 0-2.** They no longer help; LinkedIn ranks by topic, and 3+
  lowers reach. Usually none.
- **Tag** only people or companies that are in the video and would engage
  (e.g. the hackathon's organiser). Only if the handle is in `creator.md`, or
  name them in plain text and let the user tag.
- **Native video** (the vertical clip with burned-in captions) gets far more
  reach than a YouTube link. For a `_short` project, the post goes with the
  clip. For a list video, also give the user a carousel outline (below) as an
  option; document posts get about 40% more reach than average.
- **No "Agree?" / "Thoughts?" as the CTA**, no "comment YES", no "like for part
  2". A specific question that invites a 10-word answer drives comments, and
  comments count about twice what likes do.

## Hook (first 140 characters)

Line 1 stops the scroll, line 2 adds the tension, and the reader needs to
press "see more" to get the payoff. Use the speaker's own stakes and numbers:

```
I built a mobile app to $100K a month at its peak.

Now I'm starting over from scratch, and I'm doing it in public.
```

Not: a question, a definition, "I'm excited to share", "Here's what I
learned", "Stop X. Start Y."

## Templates

**Lessons / list video**
1. Hook (the result and that it came with mistakes).
2. One line of context.
3. The items, `1.` or `→`, each 1-3 short lines: what they did, what it
   cost (a number only if said), what they do now.
4. One line that sums it up in the speaker's words.
5. A specific question. Optionally a P.S. pointing at the video in words.

**Story** (a decision, a turning point)
Open in the moment of the decision → why (what they're walking away from) →
the turning point → what they learned → a question that asks for the reader's
own story.

**Build in public** (a tool, a demo, a workflow)
What I built or tried → how it works, concretely → what's still rough → what's
next → ask for one specific opinion.

**Contrarian take** (when the speaker pushes against a common belief)
The common belief → the speaker's view → their evidence from the video →
where it doesn't apply → a question that invites disagreement.

## Tone and layout

- Short paragraphs of 1-3 sentences with a blank line between them, written
  for a phone. A whole post of one-sentence lines ("broetry") reads as a
  template now. Vary it.
- First person, plain, sincere. Professional but not corporate.
- At most one emoji, ideally none. No unicode bold; it breaks search and
  screen readers.

## Avoid

"I'm thrilled/humbled to share", "Here's the thing", "Here's what/how",
"The result?", "It's not X, it's Y", "No X. No Y. Just Z.", "Stop X, start Y",
"Agree?", "game-changer", "In today's fast-paced world", emoji bullets,
hashtag blocks.

## Section layout

````markdown
## LinkedIn

Attach: `<clip>`                     <!-- if there is one -->

<!-- check: chars 3000 fold=140 -->
```text
...
```

Reply with this if someone asks for the video (don't put it in the post or first comment):

<!-- check: chars 1250 -->
```text
Here it is: https://...
```

Carousel option (list videos):   <!-- slide outline as a plain list, 6-10 slides, ~20 words each -->
````

Best time: Tue-Thu, 3-5pm or late morning. Tell the user the first hour
decides reach: answer every comment within about 15 minutes, and wait 10
minutes before fixing a typo.

## Sources

- Length and "see more" study (AuthoredUp, 372K posts): https://authoredup.com/blog/linkedin-character-limit
- See-more cut-off: https://postformatter.com/blog/linkedin-see-more-cutoff/
- Link penalty, first-comment links: https://www.forbes.com/sites/jodiecook/2026/07/23/5-linkedin-content-moves-linkedin-started-punishing-in-2026/ , https://www.tryordinal.com/blog/linkedin-link-penalty-study , https://gromming.com/blog/linkedin-external-links-penalty
- Editing after posting: https://linkedinpreview.com/blog/does-editing-a-linkedin-post-reduce-reach
- Hashtags: https://metricool.com/hashtags-on-linkedin/
- Formats (documents, video, polls): https://authoredup.com/blog/best-performing-content-on-linkedin , https://www.dataslayer.ai/blog/linkedin-algorithm-february-2026-whats-working-now
- Phrases that cost reach (MagicPost, 143K posts): https://magicpost.in/blog/ai-posts-less-engagement-linkedin
- Cadence and topic distribution (van der Blom): https://creatorscience.com/podcast/richard-van-der-blom-2/
- Post anatomy: https://www.justinwelsh.me/newsletter/the-anatomy-of-a-viral-linkedin-post
