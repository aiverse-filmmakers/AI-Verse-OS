# Moving your OS

Your AI-Verse OS is one folder. Everything that is yours lives in it: what it knows about
you, your memory, goals, projects, and your own skills (in `my-skills/`). The program files
(the skill library, the memory engine, the updater) sit next to it in `.ai-verse-tools/` and
can always be installed again, so you never need to carry them.

## Before you move

Ask your assistant "is my OS ready to move?", or run:

    python3 scripts/portability.py check

If your own skills still live outside the folder, it tells you. Fix that with:

    python3 scripts/portability.py move-skills

It copies them into `my-skills/`, checks every file, and switches over. Your old skills
folder is left alone until you delete it.

## Rename or move the folder on the same computer

Move it, then run once inside the moved folder:

    python3 scripts/portability.py repair

It points the settings at the new place (a backup of every changed file is kept in
`.aiverse/os/moved-backups/`). If you moved it to a different parent folder, run the AI-Verse
installer once there too, so the updater knows the new place.

## Copy it, or take it to another computer

Copy the folder, then run `repair` inside the copy. The copy will never touch the original:
its settings point only at itself, and its chat helpers are paused until you run the
AI-Verse installer in the copy, which gives it its own program files. On a new computer,
install AI-Verse into the copied folder in the same way.
