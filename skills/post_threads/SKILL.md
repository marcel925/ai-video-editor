---
name: post_threads
description: Write the Threads section of <project>/upload/social-posts.md from a video's transcript - a conversational 500-character post (optionally a short chain) with one topic tag, the vertical clip attached when there is one, a real question at the end, and the video link in a self-reply. Called by social_posts; use directly when the user asks for a Threads post about a video.
---

# post_threads

Write the `## Threads` section of `$P/upload/social-posts.md`. Step 1 (reading
the video), the shared rules, the unslop pass and the file format are in
`social_posts`. Read that first if you were called directly.

## Format facts (Oct 2026)

- **500 characters** per post. Mark each `<!-- check: chars 500 -->`.
- **Text attachment:** since Sept 2025 a post can carry up to 10,000 characters
  in a grey box underneath. Use it for the full list of a list video, so the
  post itself stays short. Mark it `<!-- check: chars 10000 -->`. It doesn't
  reach fediverse followers.
- **One topic tag per post.** No `#`, and spaces are allowed: `Indie Hackers`,
  `Build in Public`, `Language Learning`, `AI Tools`. Give it as a separate
  line ("Topic tag: Build in Public") for the user to pick in the composer.
  Never write hashtags in the text.
- **Links** aren't punished any more, but almost nobody clicks them. Keep the
  YouTube link out of the main post and put it in a **self-reply**: "full
  breakdown is here if you want it: <url>".
- **Native video** (up to 5 minutes, carousels up to 20 items) is the main
  reach format. Attach the vertical clip when there is one.
- **Replies drive reach**, and Meta down-ranks low-effort engagement bait. End
  on a question with a real answer.

## What feels native

Conversational, first person, a bit unpolished, like talking to people who
build things too. A confession or a specific number in line one. Then the
substance, then a question.

Off-platform tells: "🧵 1/12" X-style threads, LinkedIn broetry with "Agree?",
hashtag piles, "link in bio", a post cut off mid-sentence by a cross-poster,
an Instagram-style caption.

## Templates

**One lesson**
```
<the lesson as a confession, with the speaker's number>.

<what they do differently now, 1-2 lines>.

<a question people can answer from their own experience>?
```

**Starting / building something** (a journey or demo video)
```
<where the speaker is, in their words, e.g. "Starting a new app from zero after the last one hit $100K/month.">

<the concrete thing this video is about>.

<honest question>?
```

**List video:** the post is one item or the hook plus a one-line teaser of the
rest, and the full list goes in the text attachment. Or a chain of 2-4 posts at
most, each readable on its own. Never number them "1/5".

## Section layout

````markdown
## Threads

Attach: `<clip>`                  <!-- if there is one -->
Topic tag: Build in Public

<!-- check: chars 500 -->
```text
...
```

Text attachment (optional, list videos):

<!-- check: chars 10000 -->
```text
...
```

Self-reply with the link:          <!-- known URL only -->

<!-- check: chars 500 -->
```text
...
```
````

Best time: weekday mornings, 6-11am, with Thursday 9am the strongest. Tell the
user to reply to every comment in the first hour. Replying on other people's
posts counts about as much for growth as posting.

## Sources

- Text attachments: https://about.fb.com/news/2025/09/attach-text-threads-posts-share-longer-perspectives/
- Topic tags: https://searchengineland.com/threads-hashtags-topic-tags-435595
- Links and reach (Mosseri): https://www.threads.com/@mosseri/post/DKdzO8fumTq , https://www.socialmediatoday.com/news/meta-says-link-posts-ranked-properly-threads-reach/750126/ , https://www.engadget.com/social-media/threads-users-still-barely-click-links-170139103.html
- Ranking, replies, engagement bait: https://www.bulkpublish.com/blog/threads-algorithm/ , https://postory.io/blog/what-works-on-threads-2026
- Limits: https://www.bulkpublish.com/blog/threads-limits/
- Timing (Buffer, 2.5M posts): https://buffer.com/resources/the-best-time-to-post-on-threads/
