# Connect this project to Konteks

You are a coding agent. The person you are working with asked you to connect
the folder you are in to Konteks. Stay in that folder and do the two steps
below, in order. Nothing here needs sudo, a password or a browser.

## 1. Install the connector

    curl -fsSL -o "${TMPDIR:-/tmp}/konteks-install.sh" https://github.com/konteks-io/runtime/releases/latest/download/install.sh && sh "${TMPDIR:-/tmp}/konteks-install.sh" --user --enroll

This saves the installer to a file you can read before it runs. The installer
checks the connector against the release's published checksums and installs it
into the person's own user directory. If the connector is already installed,
running this again is safe.

## 2. Follow the steps it gives you

    konteks-remote onboard --json

Every reply is one JSON object with a `kind`:

- `ask`: put `question` to the person in their own language, word for word if
  you can, and pass back exactly what they say:
  `konteks-remote onboard --json --answer "<their answer>"`
- `run`: run exactly the `argv` given, then run `konteks-remote onboard --json`
  again. The first word of `argv` is always `konteks-remote`.
- `done`: stop, and show the person the `summary` and every link in it.

Keep going until you get `done`. Expect two questions at first, an email
address and the six-digit code Konteks mails to it, then a few about this
folder and what the person wants to build.

## Rules

- You are a relay. Never answer a question for the person, and never guess an
  email address, a code or a name.
- Do not call any other command or URL for this, and do not compose requests
  to Konteks yourself. Each reply tells you the next step.
- If `konteks-remote` is not found after step 1, open a new shell or use the
  full path the installer printed, then carry on with step 2.
- If a step fails, show the person the message as it is and stop.

macOS and Linux only. On Windows, the person creates an activation in the
Konteks app and uses the install command it shows.
