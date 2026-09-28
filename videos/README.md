# videos/

One folder per video. Each is a self-contained project — its own footage,
transcripts, and renders.

```
videos/
  introduction_video_long/    <- a project
  introduction_video_short/   <- its short-form sibling
  product_walkthrough_long/
```

## One topic, two videos

Most topics get cut twice: a long-form version for YouTube and a short-form
vertical for Shorts/Reels/TikTok. These are **separate projects**, not one
project rendered twice — the short form usually has its own recordings (shot
vertically, tighter script, a hook instead of an intro), and even when it
reuses footage it is a different edit rather than a trimmed one.

So name the pair:

```
videos/
  my_topic_long/
  my_topic_short/
```

## The `_long` / `_short` suffix

The suffix is not decoration — the tools read it. A folder ending in `_short`
is edited with the short profile without your having to say so:

```
/edit_video my_topic_short      # short form, inferred from the name
/edit_video my_topic_long       # long form, inferred from the name
/edit_video my_topic            # long form, the default for an unsuffixed name
```

An explicit flag still wins if you ever want to override it:

```
/edit_video my_topic_short long     # cut the vertical footage as long form
```

## Starting a new video

```bash
mkdir -p videos/my_topic_long/{raw_videos,assets}
mkdir -p videos/my_topic_short/{raw_videos,assets}
```

Then drop the recordings into each `raw_videos/` and run `/edit_video` on
each. The folder name is the project name — you do not type the `videos/`
prefix.

Everything else (`raw_audios/`, `transcripts/`, `build/`, the finished
`final.mp4`) is generated for you and is ignored by git, because all of it is
reproducible from `raw_videos/`.

When the finals are done, `/youtube_metadata my_topic_long` fills the
project's `upload/` folder with everything YouTube Studio needs:
`youtube-metadata.md` (title, description, chapters, tags), title-named
copies of the finals and `captions.srt`.
