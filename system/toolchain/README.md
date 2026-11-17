# Private toolchain

AI-Verse OS keeps its own copies of Node, Python and Git so members never install them
or touch Homebrew. `manifest.json` lists the oldest version each tool may be and, under
`sources`, the pinned download for each `<platform>-<arch>` with its sha256. The owner
fills `sources` in; until then the installer uses a tool already on the computer when it
is recent enough, and stops with a plain message when it is not.
