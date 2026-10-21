---
name: post_tiktok
description: Write the TikTok section of <project>/upload/social-posts.md from a video's transcript - a short lowercase caption for the vertical clip, written for TikTok search (keyword in a natural sentence, 3-5 specific hashtags, a question to drive comments), plus optional photo-carousel text for list videos. Called by social_posts; use directly when the user asks for a TikTok caption about a video.
---

# post_tiktok

Write the `## TikTok` section of `$P/upload/social-posts.md`. Step 1 (reading
the video), the shared rules, the unslop pass and the file format are in
`social_posts`. Read that first if you were called directly.

Only for a project with a vertical clip (a `_short` final, or
`shorts/<slug>/final.mp4`). On TikTok the clip does nearly all the work. The
caption is a search and comment layer, so keep it short.

## Format facts (Oct 2026)

- **Caption: 4,000 characters in the app** (about 2,200 through the posting
  API). The feed shows 1-2 lines, about 125 characters. Write 80-150 and mark
  `<!-- check: chars 2200 fold=125 -->` so an API post would fit too.
- **TikTok search reads three things:** what's said in the first seconds, text
  on screen, and the caption. The caption needs 1-2 search keywords in a
  natural sentence ("building a language learning app", "editing videos with
  AI").
- **Hashtags: 3-5, specific.** Lots of generic tags blur the categorisation.
  No `#fyp` / `#viral`.
- **No links** in captions. The bio link needs a business account or 1K
  followers. Don't mention a link unless `creator.md` says there's one in bio.
- **Photo carousels:** up to 35 images at 1080x1920, a title of up to 90
  characters, 5-10 slides of 10-20 words. Slide 1 does most of the work.
  Cheap to make for a list video.
- Upload the clean master from this pipeline, not a re-download from
  another platform.

## Caption

```
<lowercase line with the keyword, adding context the clip doesn't say> <question for the comments>? #tag #tag #tag
```

Examples of the register (use only the video's own facts):
`how i'd build my next app after the first one hit $100k/month. which of these have you done? #buildinpublic #indiehacker #appdev`

Lowercase, conversational, one or two lines. The hook lives in the video's
first second, not in the caption.

## Photo carousel (optional, list videos)

Title (search phrase, 90 characters max), then one short block per slide in a
list or "POV" style, 10-20 words each.

## Avoid

Polished marketing paragraphs, multi-paragraph Instagram-style captions,
capitalised formal prose, "link in description", `#fyp`, emoji strings.

## Section layout

````markdown
## TikTok

Upload: `<clip>`

<!-- check: chars 2200 fold=125 -->
```text
...
```

Photo carousel (optional) title:

<!-- check: chars 90 -->
```text
...
```
... one block per slide.
````

Best time: evenings and weekends work for broad audiences, and weekday
lunchtime for professional ones. Post consistently and treat any single slot
as a test.

## Sources

- Caption limits: https://charcount.tools/platforms/tiktok-caption-limit , https://deploy.social/tiktok-caption-limit
- TikTok SEO (spoken, on-screen, caption): https://www.toptal.com/creator/post/tiktok-seo , https://almcorp.com/blog/tiktok-seo/
- Photo carousels: https://gethandler.ai/tools/tiktok-size-guide/tiktok-photo-carousel-size/ , https://contentdrips.com/blog/2026/08/how-to-post-a-carousel-on-tiktok-step-by-step-2026/
