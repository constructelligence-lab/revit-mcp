# Contributing

Thanks for looking. This project has one rule that shapes everything else: **the honest version is the
product**. A tool that says "I cannot see that" is worth more than one that guesses, and a README that admits
what is untested is worth more than one with a roadmap of aspirations.

## Adding a tool

Four files, in this order, and the tests will tell you if you skipped one:

1. **`docs/protocol.md`** — the op, its arguments and its result. This is the contract; if it is not written
   down, it does not exist.
2. **`server/tools.mjs`** — one catalogue entry: `name` (snake_case), `title`, `description` (say what it
   answers and when to use it), `op`, `write: false`, and zod `params` with a `.describe()` on each.
3. **`addin/Handlers/`** — the Revit implementation, on the Revit thread. New read ops go in `ReadOps.cs`;
   anything that changes the model needs a sentence in `docs/security.md`, an entry in `RevitOps.Writes`, and
   a very good reason.
4. **`server/test/`** — catalogue invariant, bridge behaviour, and one end-to-end call over stdio.

Writes must preview by default (`apply: false`), run in one transaction, and refuse anything that changes
more than the element asked for.

## House style

- Comments explain *why*, especially where the reason is a failure you have seen: "a timeout must not apply a
  write later" beats "handle timeout".
- No claim without a source. If a number comes from Revit, say which call; if it is an estimate, say that.
- Errors are sentences a person can act on, with a code a client can branch on.
- Keep the docs generated where they can be (`npm run tools:table`, `npm run check:docs`).

## Running things

```sh
cd server && npm install && npm test      # everything that does not need Revit
npm run demo                              # a real transcript against the sample model
cd addin && dotnet build                  # compiles against the real Revit API reference assemblies
```

## Pull requests

- One change per pull request, with a test.
- If it changes the protocol, say so in the title; `docs/protocol.md` and the CHANGELOG go in the same commit.
- If it changes what a model can do, say what a user would have to do to allow it, and what happens when they
  do not.
