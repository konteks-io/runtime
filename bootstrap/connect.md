# Connect this project to Konteks

You are a coding agent. The person you are working with asked you to connect
the folder you are in to Konteks. Konteks will install its connector for this
user, connect this machine to the person's Konteks workspace, and offer to make
this folder their first System. Nothing here needs sudo, a password or a browser.

## 1. Run the one install command

    curl -fsSL -o "${TMPDIR:-/tmp}/konteks-install.sh" https://github.com/konteks-io/runtime/releases/latest/download/install.sh && sh "${TMPDIR:-/tmp}/konteks-install.sh" --user --enroll

Run it from the folder you are in. It saves the installer to a file you can
read before it runs, checks the connector against the release's published
checksums, installs it into the person's own user directory, and starts
onboarding. Running it again is safe.

## 2. Relay each step

The last thing the install prints is the first step, one JSON object. Every
later step comes from running, in the same folder:

    konteks-remote onboard --json

Each step has a `note`, an `ask`, a `run` or a `done`, sometimes more than one:

- `note`: tell the person what it says, in its words. Leave nothing out and add
  nothing of your own.
- `ask`: put `ask.question` to the person, word for word, on its own, and wait
  for their reply. Then run
  `konteks-remote onboard --json --answer "<their answer>"` with the reply
  exactly as they gave it.
- `run`: run exactly `run.argv`, then `konteks-remote onboard --json` again.
  Its first word is always `konteks-remote`.
- `done`: stop, and show the person `done.summary` and every link in it.

The questions are about the person's email, a code Konteks mails them, this
folder and what they want to build. Some steps take up to a minute; the `note`
before them says so.

## Rules

- You are a relay. Never answer a question for the person, and never guess an
  email address, a code or a name.
- Keep your messages short: the step's note, then its question. Don't say what
  you will do with the answer, what the next step will be, or which command you
  run; don't say the same thing twice or mention install paths.
- Run nothing else for this and call no other address. Do not compose requests
  to Konteks yourself; each step tells you the next one.
- If `konteks-remote` is not found, use the full path the install printed.
- If a command fails outright, show the person its message as it is and stop.

macOS and Linux only. On Windows, the person creates an activation in the
Konteks app and uses the install command it shows.
