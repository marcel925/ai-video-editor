---
name: post_x
description: Write the X (Twitter) section of <project>/upload/social-posts.md from a video's transcript - a standalone post, a thread for list videos, or a native-clip post - in X's own register (short, specific, opinionated, no hashtags, no thread emoji). Called by social_posts; use directly when the user asks for a tweet, a thread or "an X post" about a video.
---

# post_x

Write the `## X` section of `$P/upload/social-posts.md`. Step 1 (reading the
video), the shared rules, the unslop pass and the file format are in
`social_posts`. Read that first if you were called directly.

## Format facts (Oct 2026)

- **280 weighted characters** per post on a free account. A URL counts as 23;
  emoji and CJK count as 2. Mark every block `<!-- check: x 280 -->`.
  Premium allows long posts, but the feed cuts them at about 280 with "Show
  more", so write for 280 and use a thread when there's more to say.
- **Hashtags: none.** At most one, and only for a named event (a hackathon
  tag). Several hashtags read as spam and filters treat them that way.
- **Links aren't down-ranked any more** (X's head of product, July 2026), but a
  bare "new video [link]" post gets almost nothing. The post has to be worth
  reading without the link. Put the video link in the **last post of a
  thread, or in a reply** to a standalone post.
- **Native video** gets video-view ranking; YouTube embeds don't. Attach the
  vertical clip whenever there is one, and still write a text hook.
- **Replies rank highest.** A reply the author answers counts far more than a
  like. End on something people can answer from their own experience.
- **Engagement bait is detected and down-ranked**: "reply X and I'll DM you",
  "follow everyone who replies", "like if you agree".

## What to write

Pick by content:

**List video (mistakes, lessons, steps):** a thread of 5-8 posts.
- Post 1 is the hook alone, a complete post someone would like without
  reading further. Name the count and the credential the speaker gives:
  `5 mistakes i made growing my first app to $100k/month`.
  End post 1 with a colon or a plain line, never "🧵", "a thread 👇" or "1/".
- One item per post: the mistake, what it cost (only a number the
  speaker said), what they do now. No numbering emoji; `1.` or "first:" is fine
  if needed.
- Last post: one line that ties it up, then the video link if known (`full
  video: <url>`). If the speaker named their product, one plain line about it.

**One-idea video or a single strong item:** a standalone post, 1-4 short
lines, one opinion, one specific number. Video link in a reply block.

**`_short` project or attached clip:** the clip plus 1-2 lines that add
something the clip doesn't say outright (the stakes, the number, the
contrarian bit). Don't caption the clip with its own first sentence.

**Build-in-public angle** where the speaker gives progress: plain status lines
(`users: ... · what broke: ...`) only with values the speaker actually said.
These `label: value` lines are an X convention and win over unslop rule 14.

## Tone

- Lowercase-casual is normal for indie and builder accounts; sentence case is
  fine too. Pick one and keep it across the thread.
- Short lines, plain words, one idea per post. Specific beats impressive.
  Failures and admissions travel.
- Sounds like a person typing: contractions, the speaker's own phrases, some
  roughness. Polished, balanced, agreeable sentences read as AI, and X's bot
  filters target that tone.

## Avoid

"🧵", "a thread 👇", "here's what i learned:", "let's dive in", "bookmark
this", "most people don't know", numbered emoji (1️⃣), "game-changer",
"unlock", emoji walls, hashtags, "new video out!", rhetorical questions with
no real answer, "thoughts?".

## Section layout

````markdown
## X

Attach: `<clip>` to post <n>        <!-- only if there is one; the post it illustrates -->

Thread (post each as a reply to the one before):

<!-- check: x 280 -->
```text
...
```
...
Reply with the link:               <!-- standalone post + known URL only -->

<!-- check: x 280 -->
```text
full video: https://...
```
````

Best time to put in the summary table: Tue-Thu, 8-11am in the audience's time
zone. Tell the user to answer every reply in the first hour or two.

## Sources

- Link penalty removed: https://www.freepressjournal.in/tech/x-product-head-nikita-bier-confirms-link-penalty-removed-over-a-year-ago-tells-mark-zuckerberg-he-can-post-them-directly
- Format engagement (text 3.56% > image > video > links 2.25%): https://buffer.com/resources/data-best-content-format-social-media/
- Long posts and truncation: https://help.x.com/en/using-x/x-premium-how-to
- Hashtags: https://postory.io/blog/twitter-hashtags-2026
- Ranking signals, replies, video views: https://postory.io/blog/x-algorithm-2026 , https://publora.com/blog/x-algorithm-open-source
- Engagement-bait down-ranking: https://piunikaweb.com/2026/03/20/x-grok-downrank-engagement-bait-nikita-bier/ , https://www.socialmediatoday.com/news/x-updates-its-engagement-bait-detection/825495/
- AI-reply filtering: https://techweez.com/2026/09/03/x-ai-generated-bot-replies/
- Timing: https://buffer.com/resources/best-time-to-post-social-media/
