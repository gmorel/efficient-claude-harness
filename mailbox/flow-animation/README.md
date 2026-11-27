# mailbox/flow-animation

`build.py` builds the script-free animated SVG of the mailbox flow: `python3 mailbox/flow-animation/build.py docs/mailbox-flow.svg`.
Every step it animates comes from `plugins/ech-mailbox/hooks/register.ts`; it shows no figures, counters or logos.
`build.test.mjs` tests the generator: `node --test mailbox/flow-animation/build.test.mjs`.
