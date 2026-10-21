---
name: post_instagram
description: Write the Instagram section of <project>/upload/social-posts.md from a video's transcript - a Reels caption for the vertical cut (hook under 125 characters, keywords in plain words, a save/send CTA, at most 5 hashtags), or slide-by-slide carousel text for a list video. Called by social_posts; use directly when the user asks for an Instagram caption, a Reel caption or a carousel about a video.
---

# post_instagram

Write the `## Instagram` section of `$P/upload/social-posts.md`. Step 1
(reading the video), the shared rules, the unslop pass and the file format are
in `social_posts`. Read that first if you were called directly.

## Format facts (Oct 2026)

- **Caption: 2,200 characters.** The feed shows about **125 characters** before
  "... more". Mark `<!-- check: chars 2200 fold=125 -->`.
- **Hashtags: at most 5**, a hard cap since Dec 2025; extras are ignored. They
  help Instagram categorise the post but don't add reach. Use specific tags
  (`#indiehacker #buildinpublic #languagelearning`), not generic ones
  (`#motivation #success`).
- **Captions are search.** Public professional posts are indexed by Google and
  Bing, and Instagram search reads captions. Put the topic in plain words
  ("language learning app", "AI video editing").
- **Links don't work in captions.** Never paste a URL. Say "link in bio" only
  if `videos/creator.md` says the bio carries the link; otherwise "full video
  on my YouTube channel". Once at most.
- **Ranking:** watch time, then sends per reach (DM shares, the strongest signal
  for reaching non-followers), then saves and likes. A CTA that asks for a send
  or a save beats "like and follow".
- **Originality:** upload the clean 9:16 master from this pipeline, never a
  file re-downloaded from TikTok. Watermarked reposts get pushed down.
- **Carousels:** up to 20 slides at 1080x1350. 7-10 slides of 15-30 words, one
  idea per slide. Carousels get about twice the engagement of Reels, and Reels
  get more reach.

## Which one

- **Vertical clip exists** (a `_short` final or `shorts/<slug>/final.mp4`):
  a Reels caption for it.
- **List video** (long form): carousel slide text too, or alone if there is no
  clip.

## Reels caption

```
<hook line under 125 characters that adds to the clip rather than repeating its first sentence>

<2-4 short lines: the number, the lesson, the why>

<one CTA: "Send this to someone building an app" / "Save this for your next launch">

#tag #tag #tag
```

Write it in plain sentence case, warmer than LinkedIn and shorter than a
blog post. Up to 2 emoji, only if they mean something.

## Carousel text

One block per slide, numbered in the plain-text label, not inside the slide:

- **Slide 1:** the hook and credibility, under 12 words ("5 mistakes I made
  growing an app to $100K/month").
- **Slides 2-N:** one item each: the mistake or lesson in a headline, then 1-2
  lines of what to do instead.
- **Second-to-last:** a recap.
- **Last:** "Full story on my YouTube channel" (plus "link in bio" if `creator.md` says so) and a save/send
  ask.

Then a short carousel caption: the hook, 1-2 lines, the hashtags.

## Avoid

"In this video I'll...", a pasted URL, more than 5 hashtags, emoji at the start
of every line, "Here's the thing", "Let's dive in", "game-changer", a caption
that just repeats what the clip says.

## Section layout

````markdown
## Instagram

Reel: upload `<clip>`

<!-- check: chars 2200 fold=125 -->
```text
...
```

Carousel (list videos), slide 1:

<!-- check: chars 200 -->
```text
...
```
... one block per slide, then the carousel caption with its own 2200 check.
````

Best time: weekday late morning to early afternoon. Tell the user to reply to
comments in the first hour.

## Sources

- Caption limit and truncation: https://growthscribe.com/instagram-caption-character-limit/
- 5-hashtag cap: https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/
- Google indexing: https://www.searchengineworld.com/its-live-instagram-posts-are-ranking-and-showing-in-google-and-bing-seo-meets-social
- Ranking signals (Mosseri): https://www.socialync.io/blog/adam-mosseri-shares-instagram-algorithm-2026 , https://www.dataslayer.ai/blog/instagram-algorithm-2025-complete-guide-for-marketers
- Originality and watermarks: https://exemplary.ai/blog/instagram-algorithm-original-content
- Reels vs carousels (Buffer, 52M posts): https://buffer.com/resources/state-of-social-media-engagement-2026/
- Per-slide captions: https://metricool.com/instagram-carousel-multiple-captions/
