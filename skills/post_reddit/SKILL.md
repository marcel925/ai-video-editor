---
name: post_reddit
description: Write the Reddit section of <project>/upload/social-posts.md from a video's transcript - one or two value-first text posts, each written for a specific subreddit's rules (title, body, flair, link policy), complete without the video, with the founder affiliation disclosed. Called by social_posts; use directly when the user asks for a Reddit post about a video.
---

# post_reddit

Write the `## Reddit` section of `$P/upload/social-posts.md`. Step 1 (reading
the video), the shared rules, the unslop pass and the file format are in
`social_posts`. Read that first if you were called directly.

Reddit is the platform most likely to punish a post that looks generated or
promotional. Readers call out AI text in the comments, and mods remove posts
and ban accounts. The post has to be something a member would write for the
sub, with the video as a footnote at most.

## Format facts (Oct 2026)

- **Title:** 300 characters max, but aim for 60-120. Mark
  `<!-- check: chars 300 -->`.
- **Body:** 40,000 characters max; 200-600 words works best for founder case
  studies. Mark `<!-- check: chars 40000 -->`. Reddit renders Markdown, but
  use plain paragraphs. Bold section headers and tidy "Key takeaways" lists are
  the first things readers point to as AI.
- **No sitewide 9:1 rule any more**, but mods still check whether the account
  mostly contributes or mostly promotes, and each sub's own rules decide. A
  bare YouTube link post fails almost everywhere.
- Upvoted threads rank in Google and get cited by AI answers and Reddit Answers
  for years. Write the title like something people search for.

## Pick the subreddit(s)

Pick one sub, or two if two clearly fit, and write a **different version for
each**. Identical text in several subs reads as spam. Rules below are from
third-party trackers (Oct 2026); tell the user to check the sidebar before
posting.

| Topic | Subreddit | Rules that matter |
|---|---|---|
| Project or tool the speaker built | r/SideProject | Sharing projects is the point. Title "[Name] - [what it does]" or "I built ... for ...". Link fine. |
| Founder lessons, revenue, build in public | r/indiehackers | One self-promo post per product, "Self Promotion" flair, framed as asking for feedback. Journey posts with numbers do well. |
| Founder lessons (big audience) | r/Entrepreneur | **No links anywhere**, not even YouTube. Promotion only in weekly threads. Case studies with metrics, 200-600 words. |
| Startup lessons | r/startups | Can't name your own project outside the "Share Your Startup" thread. No commercial links. |
| SaaS / subscription app lessons | r/SaaS | Conflicting reports: roughly one mention per 60 days, tactical posts only. Weekly "Share Your SaaS" thread. Leave the link out. |
| Claude / Claude Code workflow | r/ClaudeAI | "Built with Claude" flair needs what you built, how, a demo, and at least one real prompt. Promotion needs mod OK or the megathread. |
| AI coding workflow | r/ChatGPTCoding | Self-promo OK; weekly "Share your work" thread. |
| iOS app dev | r/iOSProgramming | App Saturday only, with flair: tech stack, one dev challenge and how it was solved, and an AI-use disclosure. |
| Language learning | r/languagelearning | Own content less than once a month, mod approval first, affiliation stated. Only if the post genuinely helps learners. |
| Video editing | r/videoediting | No written policy and young-account link posts get auto-removed. Modmail first. |

Flair: name the one the sub needs if the table gives it; otherwise write
"pick the flair in the composer" in the section's header line.

Prefer the sub where the post teaches something without the video. If no sub
fits the video, skip Reddit and say so in the report.

## Writing the post

- **Title:** first person, specific, with the speaker's number. "I grew my
  first app to $100K/month and made a lot of mistakes. The 5 that cost me
  most". Not clickbait, no emoji, no all-caps. Be ready for people to ask for
  proof of any number in the title.
- **Body:** the whole content as text. A list video gives every item with the
  speaker's reasoning, so a reader who never clicks has everything. Plain
  paragraphs; a simple numbered list is fine for list content.
- **Disclose** in one plain line that the speaker made the app or tool ("I'm the
  founder, so I'm biased.") whenever it's named.
- **Video:** only where the sub allows links, as one plain line at the end ("I
  also made a video going through this: <url>"). Where links are banned or
  limited, leave it out and give the line as a block the user can post as a
  comment if someone asks.
- **End** with a real, specific question for the sub ("Anyone here learned
  onboarding from a different kind of app?"), not "What do you think?".
- Tone: humble, candid, specific, slightly rough. Mention what went wrong.
  Reddit likes admissions and distrusts polish.

## Avoid

Em dashes (people notice them), bold headers, "Key takeaways", "TL;DR" at the
top, emoji, "game-changer", "I'm excited to share", "Hope this helps!", a
feel-good CTA, hashtags, marketing adjectives, posting the same body in
several subs.

## Section layout

````markdown
## Reddit

Subreddit: r/indiehackers · flair: Self Promotion · link allowed in body
Before posting: check the sidebar rules; post from an account with history in the sub.

Title:

<!-- check: chars 300 -->
```text
...
```

Body:

<!-- check: chars 40000 -->
```text
...
```

Second subreddit: r/... (if any), with its own title and body.
````

Best time: weekday mornings in US Eastern time. Tell the user to stay for the
first hours and answer comments; abandoned posts get removed.

## Sources

- Self-promotion policy: https://prowlo.com/blog/reddit-self-promotion-rules , https://forkoff.xyz/answers/reddit-self-promotion-rules
- Subreddit rules: https://www.threadotter.com/subreddit-rules/Entrepreneur , https://www.threadotter.com/subreddit-rules/startups , https://www.redditmaster.com/subreddit-rules/saas , https://www.threadotter.com/subreddit-rules/ClaudeAI , https://www.threadotter.com/subreddit-rules/languagelearning , https://iwe.md/templates/marketing-workspace/data/communities/reddit/iosprogramming/ , https://saascity.io/best-subreddits-for-indie-hackers
- AI-text tells readers flag: https://www.npr.org/2025/11/10/nx-s1-5596088/inside-the-unofficial-movement-to-save-the-em-dash-from-a-i
- Search and AI citations: https://thedigitalbloom.com/learn/google-ai-overviews-top-cited-domains-2025/
