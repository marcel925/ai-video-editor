---
name: social_posts
description: Turn a finished video's transcript into copy-paste posts that read as native to each platform - X, Reddit, Threads, LinkedIn, Instagram, TikTok and Indie Hackers - written to <project>/upload/social-posts.md, each one passed through /unslop and checked against the platform's character limit. Runs automatically after /youtube_metadata at the end of every final render; also use when the user asks for social posts, a LinkedIn post, a tweet or thread, a Reddit post, captions for Reels/TikTok, or "repurpose this video". Accepts one project name or "all".
---

# social_posts

Each video also becomes a set of posts for the other platforms, one per
platform. Each one is written as if the speaker sat down to write for that
platform, not cross-posted. Everything lands in one file next to the YouTube
metadata:

```
$P/upload/
  youtube-metadata.md     (youtube_metadata)
  social-posts.md         every platform's post, in copy-paste blocks
  youtube-url.txt         optional, one line: the published video's URL
```

```
/social_posts <project_name>      # one video, every platform it qualifies for
/social_posts all                 # every project under videos/ with a timeline
/post_linkedin <project_name>     # one platform only (also post_x, post_threads, ...)
```

`$PY`, `$T` and `$P` are as in the `edit_video` skill:

```bash
PY="${CLAUDE_PLUGIN_DATA}/venv/bin/python"; T="${CLAUDE_PLUGIN_ROOT}/tools"
```

(or `PY=.venv/bin/python; T=tools` in a clone). `$P` is `videos/<project_name>`.

When `youtube_metadata` calls this after a final render, go straight through
without asking. Stop only if `social-posts.md` already exists and the user
may have edited it: ask, or update only the sections that changed.

## The platforms, ranked

Scored 1-10 for how much a text adaptation of a talking-head YouTube video
is worth on each platform for a founder / build-in-public / tech-creator
channel. The scores come from research done in October 2026; the sources are
in each platform skill. The file lists platforms in this order.

| # | Platform | Score | Skill | Why it ranks here |
|---|---|---|---|---|
| 1 | X | 8 | `post_x` | Closest audience to founder and AI-tooling content. Build-in-public with real numbers is native there, and replies drive ranking. Sends modest traffic to YouTube. |
| 2 | Reddit | 8 | `post_reddit` | Value-first text posts in the right subreddit get read, ranked in Google and cited by AI answers for years. Most effort: every subreddit has its own rules, and readers call out AI text and promotion. |
| 3 | Threads | 7 | `post_threads` | Large audience, conversational, rewards replies and native video. Few clicks out, so it builds audience rather than views. |
| 4 | Instagram | 7 | `post_instagram` | Reels caption for the vertical cut, or a carousel for a list video. Saves and sends rank, and captions are indexed by Google. |
| 5 | LinkedIn | 6 | `post_linkedin` | Founder lessons with numbers fit, and long text posts still get read. Links are suppressed and reach is falling, so it's for credibility, not views. |
| 6 | TikTok | 6 | `post_tiktok` | The clip does the work; the caption is a search layer. Only when a vertical video exists. |
| 7 | Indie Hackers | 6 | `post_indiehackers` | Revenue-transparent founder posts are exactly its format. Smaller, peer audience. |

Not built, and why:

| Platform | Score | Why not |
|---|---|---|
| Email newsletter | 9 | The best long-term channel, but it needs a list the user owns. Add a `post_newsletter` skill once they have one. |
| dev.to / Medium | 7 for technical videos, 3 otherwise | Worth it for tool and workflow videos only. Publish the article with a canonical URL. |
| Bluesky | 4 | Small and shrinking, and hostile to hustle and AI-made content, which is most of this channel's material. |
| Facebook | 3 | Page reach is 1-3% and Meta is limiting link posts. If anything, upload the vertical clip as a Facebook Reel. |
| Hacker News | 2 | Show HN is for things people can try, not videos, and AI-edited text is banned. The exception is a Show HN for an open-source tool the video is about, posted by hand. |

### Which platforms each project gets

- **Always X, Threads and LinkedIn.**
- **Reddit** when a subreddit in `post_reddit` fits the topic. Skip a
  `_short` that has a `_long` sibling: Reddit gets the full version once.
- **Indie Hackers** for founder, revenue or build-in-public content. Same
  sibling rule as Reddit.
- **Instagram and TikTok** when there is a vertical video to post with them:
  a `_short` project's `final.mp4`, or a long project's `shorts/<slug>/final.mp4`.
  A long list video with no vertical cut gets an Instagram carousel instead,
  and no TikTok post.
- For a `_long` / `_short` pair, do both together. The long one carries the
  long-form posts. The short one gets native-clip posts (the clip plus one or
  two lines) for X, Threads, LinkedIn, Instagram and TikTok, angled
  differently from the long one's posts so both can go out in the same week.

## Step 1 - read the video

1. `$PY $T/words.py $P` is the only source for what the video says. Read
   all of it. Never write from the segment list or the raw transcripts,
   which still contain the takes that were cut.
2. `$P/upload/youtube-metadata.md` if it exists: title 1 is how the posts
   refer to the video, and its description shows which claims were judged
   safe.
3. `$P/upload/youtube-url.txt`, the published URL. The user drops it there
   after uploading. If it doesn't exist, check `youtube-metadata.md` and ask
   only if the user mentions having uploaded.
4. `videos/creator.md` if it exists: handles, product URLs, and voice notes
   the user wants every post to follow. It is the only place a handle or URL
   may come from besides the video URL.
5. Vertical files to attach: `$P/final.mp4` for a `_short`,
   `$P/shorts/*/final.mp4` for a long project (`$P/build/shorts.json` has
   each one's lines, and `$PY $T/words.py $P/shorts/<slug>` its transcript).
   Get each clip's length with `ffprobe` and check it against the table
   below. With no final yet, name the `final.mp4` to attach once it's
   rendered, and note that only `preview.mp4` exists now.
6. The sibling project's `words.py` and posts, if any, so the two sets don't
   repeat each other. A sibling is the `_long` / `_short` pair, or a long and a
   short project that cover the same topic.

**Which clip goes where.** With several clips, give each platform a
different one, so a follower on two platforms doesn't see the same clip
twice. Skip a long project's short that mostly repeats the `_short` sibling's
final. On an X thread, attach the clip to the post whose item it shows, not
automatically to post 1.

**Clip length limits** (native upload, Oct 2026; check if a clip is close):

| Platform | Max | Notes |
|---|---|---|
| X | 2:20 free, longer with Premium | Over 2:20: say "needs Premium, or post as text". |
| Threads | 5:00 | |
| Instagram Reels | 3:00 | Longer uploads aren't recommended to non-followers. |
| TikTok | 10:00 in the app | |
| LinkedIn | 15:00 desktop, 10:00 mobile | 30-90 s performs best. |

Then pick, before writing anything:

- **The one idea** each post is about. A list video gives a list post on
  platforms where lists are native (X thread, LinkedIn, Reddit, carousel), and
  its single strongest item on the others.
- **The specifics the speaker actually said**: numbers, names of tools,
  the before/after. These are what make a post work on every platform.

## Step 2 - write each platform's section

Load each platform skill in ranking order and follow it for that section:
`post_x`, `post_reddit`, `post_threads`, `post_instagram`, `post_linkedin`,
`post_tiktok`, `post_indiehackers`. Each skill states its limits, format,
hook, structure, tone and link rule.

Rules every platform shares:

- **The speaker's words, in their voice.** First person, as the speaker.
  Reuse their phrasing where it's good ("Use your own app every day"). Clean
  up spoken filler; never change what they said or claimed.
- **No new facts.** Only numbers, results, names and claims that appear in
  `words.py`. "About $0.50 per download, then 5-6x" stays exactly that. Don't
  invent a timeline, a metric, a screenshot, or a story detail to make a hook
  sharper. If a template slot needs a number the video doesn't give, use
  another template.
- **Facts from a sibling's transcript count**, since it's the same speaker on
  the same topic. A short's posts may use them to say what the clip doesn't.
- **Say what the speaker framed it as.** A lesson stated as general advice is
  a lesson, not "a mistake I made", unless the speaker says they got it
  wrong. Don't invent the admission.
- **No placeholders, ever.** No `[link]`, `<url>`, `{{...}}`. A post block
  must be pasteable as-is. A handle or URL appears only if it comes from
  `youtube-url.txt` or `creator.md`.
- **The post stands on its own.** Someone who never clicks gets the whole
  point. The video is offered as more depth, never as the payoff ("watch to
  find out" is out).
- **Link placement follows the platform skill.** With no video URL yet,
  leave the link blocks out and put the note at the top of the file (below).
- **Every platform gets a different post.** Same facts, different angle,
  length and register. A reader who follows the speaker in two places must
  not see the same text twice.

## Step 3 - unslop every post

Load `/unslop` and run it on every post block, with the **user-facing rule
set (all 31 rules)**. Then:

- Re-apply the platform's own conventions where the skill says they win
  (LinkedIn's short paragraphs, Threads' single topic tag, TikTok's
  lowercase).
- Re-read each post against the transcript. Unslop must not have added or
  sharpened a claim.
- No em or en dashes in any post. Rewrite with a period or a comma.

## Step 4 - write the file and check it

`mkdir -p "$P/upload"`, then write `$P/upload/social-posts.md` in exactly this
shape, so every project reads the same:

````markdown
# Social posts: <project_name>

Video: <URL from youtube-url.txt>
<!-- or, with no URL yet: -->
Video: not uploaded yet. Put the URL in `upload/youtube-url.txt` and re-run
`/social_posts <project_name>` to fill in the link replies.

Attach: `shorts/onboarding_5x/final.mp4` (vertical, 0:48)  <!-- the native clip(s), if any -->

| Platform | Post | Best time |
|---|---|---|
| X | thread, 6 posts | Tue-Thu 8-11am |
| ... | | |

## X

Attach: `<file>` to post 1   <!-- only if a native clip goes with it -->

<!-- check: x 280 -->
```text
post 1
```

<!-- check: x 280 -->
```text
post 2
```

## Reddit
...
````

- Each platform is an `## <Platform>` section in ranking order, with only the
  platforms this project gets.
- **Every block someone pastes is its own fenced `text` block** with a
  `<!-- check: ... -->` marker on the line above. The marker gives the
  counting mode (`x` for X's weighting, `chars` for everything else), the
  platform limit, and for platforms that truncate, `fold=<chars>` for the
  "see more" cut-off. Titles, first comments and link replies are blocks too.
- A block that can only be written once the URL is known (a link reply, a
  "post this comment if someone asks" line) is left out until then. The note
  at the top of the file covers it.
- Short plain-text lines outside the blocks say where each block goes ("Title",
  "First comment", "Subreddit: r/SideProject, flair Show-off").

Then run:

```bash
$PY $T/postcheck.py $P
```

It counts every block against its limit, prints what shows above the fold,
and fails on a dash or a placeholder. Fix everything it reports, then read
each "above the fold" line once more: does it make someone stop scrolling?
Re-run until it exits 0.

## Report

One table per run: project, the platforms it got, and anything the user has
to do by hand (upload the clip, pick the subreddit flair, check that sub's
rules for this week). Mention any post you shortened or skipped and why.
Don't paste the posts into chat; point to `upload/social-posts.md`.
