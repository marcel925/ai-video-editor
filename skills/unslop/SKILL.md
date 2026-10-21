---
name: unslop
description: >
    Strip AI tells out of writing and put a voice back - puffery, "not just X but Y", chatbot filler,
    metaphor jargon, feeling-words over mechanisms. Full rules for USER-FACING copy (social posts, YouTube
    descriptions, titles), a reduced set for internal docs. Every post from social_posts goes through it.
    Use when: "unslop this", "this reads like AI", "make this sound human", "de-slop the copy", or before
    publishing any text.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# unslop - Cut the AI tells, put a voice back

Edit text to remove AI patterns and add human voice. The full pattern list is in
[`references/patterns.md`](references/patterns.md); read it before editing.

## Pick the rule set first

| Scope | Rule set | Why |
|---|---|---|
| **User-facing copy**: social posts, YouTube titles, descriptions, pinned comments, captions | **All 31 rules.** | This is where an AI tell costs reach. Readers on every platform now scroll past text that smells generated, and Reddit and Bluesky call it out in the comments. |
| **Internal docs and code comments**: `SKILL.md` files, READMEs, `reference.md`, comments | **All rules EXCEPT 13 and 26.** | This repo's skill files use em dashes and words like "surface" freely. Changing that is a style migration, not a de-slopping pass. |

Everything else applies to both. Rules 27-31 (say what it does not how it feels, split dense sentences,
active voice, cut adverbs, plain words) improve internal prose as much as posts.

## Process

1. **Name the scope** and therefore the rule set. Say which one you used in your report.
2. **Scan for the patterns** in `references/patterns.md`.
3. **Rewrite.** Preserve meaning, match the intended tone.
4. **Add soul** (below). Removing patterns is half the job.
5. **Self-audit.** Ask "what still makes this obviously AI generated?" and fix what's left.

## Adding soul

Sterile, voiceless writing is as obvious a tell as puffery. Stripping the patterns and stopping produces
prose that reads like a compliance document.

- **Have opinions.** React to the facts instead of neutrally listing pros and cons.
- **Vary rhythm.** Short sentences. Then longer ones that take their time. Mix it up.
- **Acknowledge complexity.** "Impressive but also kind of unsettling" beats "impressive".
- **Use "I" or "we" when it fits.** First person isn't unprofessional.
- **Let some mess in.** Perfect structure looks machine-made.
- **Be specific.** Not "this is concerning" but the actual thing that's concerning.

## Constraints that override a stylistic improvement

These are hard. A better sentence that breaks one of them is not shippable.

- **The speaker's words win.** Copy adapted from a video keeps the speaker's own claims, numbers and
  phrasing. Unslop the connective tissue around them; never sharpen a number ("about $0.50" stays about
  $0.50), add a claim, or put words in their mouth that the transcript doesn't support.
- **Character limits are hard limits.** Each platform skill (`post_x`, `post_threads`, ...) states its
  limit. Re-count after rewriting; a rewrite that adds a sentence can push a post over.
- **Never invent a claim, a URL or a handle.**
- **Rule 13 covers the text that gets posted**, not the labels around the
  blocks in `social-posts.md`. A hyphen in a number range ("$20-30", "5-6x") is
  not a dash; keep it.
- **Platform conventions beat a generic rule where the platform skill says so.** A platform skill may
  call for things this list would otherwise strip, such as short phone-width paragraphs on LinkedIn, a
  single topic tag on Threads, or `label: value` status lines in a build-in-public update (rule 14
  doesn't apply to those). Keep those. Everything else on the list still applies.

## Report

Say which rule set you applied and why, list the patterns you found by number, and show before/after for the
substantive rewrites. Where you left something alone because a constraint above outranked the improvement,
say that too - a listed-but-declined edit is more useful than a silent one.

<!-- Port of the unslop skill from the LyricFluent monorepo, itself adapted from the MIT-licensed
`pstack` plugin (c) 2026 Lauren Tan: https://github.com/cursor/plugins/tree/main/pstack -->
