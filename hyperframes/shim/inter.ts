// Stands in for @remotion/google-fonts/Inter. The faces themselves come from
// @fontsource/inter, declared in lib/fonts.css and served from disk, so a
// render never waits on Google Fonts.
export const loadFont = (..._args: unknown[]) => ({fontFamily: 'Inter'});
