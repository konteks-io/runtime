# Connect this machine to Konteks

Paste the block below into Claude Code, Codex or OpenCode, in a repository
you care about. Your agent will run two commands and then relay a few short questions.

```
Run these two commands and then follow the JSON the second one prints.
The first downloads the installer to a file you can read, then runs it: it
checks the connector against the release's published checksums and installs
into your user directory only, with no sudo.

  curl -fsSL -o "${TMPDIR:-/tmp}/konteks-install.sh" https://github.com/konteks-io/runtime/releases/latest/download/install.sh && sh "${TMPDIR:-/tmp}/konteks-install.sh" --user --enroll
  konteks-remote onboard --json

Each response has one of three shapes:
  "ask"  — put the question to me and pass my answer back with
           konteks-remote onboard --json --answer "<my answer>"
  "run"  — run exactly that argv, then run konteks-remote onboard --json again
  "done" — stop, and show me the summary and links

Do not call any other command or URL for this, and do not compose requests to
Konteks yourself. Everything you need is in the next step.
```

## What happens

1. The connector installs into your own user directory. No `sudo`, no package,
   no password prompt.
2. You are asked for an email address. Konteks sends a six-digit code.
3. You paste the code. That is the last question before the machine is
   connected. If the address already belongs to a workspace, this machine
   joins it; otherwise a workspace is created for you.
4. Your agent reports the folder you are in and asks whether to make it your
   first System. A repository with no remote this machine can push to, or a
   folder that is not a git repository yet, is offered a Konteks managed one
   instead. Nothing is pushed until you say yes; a plain folder becomes a git
   repository joined to the one Konteks made for it, and none of your files is
   added or changed.
5. You are asked what you want to build first. Your answer becomes your first
   initiative on that System, and its planning session starts on this machine
   with your sentence as its first message. Your agent gives you the
   initiative's link.

Answering nothing at the last question ends the flow. Running
`konteks-remote onboard --json` again on a connected machine reports who it is
and picks up at the repository step.

## What it does not do

- It never asks for a password, and Konteks never sends one.
- The six-digit code is the only secret that passes through your chat, it is
  single use, and it expires in ten minutes.
- Your agent is a relay. It is never given a Konteks URL or credential, and
  the only command it is ever asked to run is `konteks-remote`.
- The Claude Code or Codex login you already have, or the sign-in of your own
  OpenCode or DeepSeek Harness, is what runs Konteks work on this machine. You
  are not asked to set up a provider.

## Agents

Konteks runs the coding agents already on this machine: Claude Code, Codex,
DeepSeek Harness and OpenCode 2, and Google Antigravity, which it downloads
from Google after you say yes. Onboarding finds the ones installed and says
what each still needs.

OpenCode 2 is the version OpenCode's homepage installs; OpenCode 1 is not
supported. To add it, in your own terminal:

```
curl -fsSL https://opencode.ai/v2/install | bash
konteks-remote agent add opencode
konteks-remote auth login opencode
```

The last command lists what your OpenCode can sign in to (a subscription such
as ChatGPT, GitHub Copilot or OpenCode Console, or any provider's API key,
typed without echo). If you already use OpenCode, add `--reuse` to start from
the providers it is signed in to. On Windows, install it with
`npm install -g @opencode/cli`.

OpenCode runs in a scrubbed environment: Konteks gives it a private home and
only the settings it needs, never your `GITHUB_TOKEN`, provider keys or other
credentials from your shell, and never touches your own OpenCode sign-ins.

Google Antigravity (for Gemini) is not found on the machine: Konteks downloads
Google's own copy after you say yes, so onboarding only offers it, in one line,
when no other agent is here. To add it, in your own terminal:

```
konteks-remote agent add antigravity
konteks-remote auth login antigravity --api-key
```

The first command asks before it downloads anything from Google (about
110 MB, 400 MB on disk). Sign in with a Gemini API key (typed without echo),
or with Gemini Enterprise:
`konteks-remote auth login antigravity --enterprise --project <your Google Cloud project ID> --location global`
(the project needs Google's Business AI Code API:
`gcloud services enable businessaicode.googleapis.com --project <your Google Cloud project ID>`,
and your Google Cloud admin must set Terminal auto-execution to Require
review). It runs in the same scrubbed environment, never touches `~/.gemini`,
the Antigravity app or your keychain, and
`konteks-remote agent remove antigravity` takes it off again.

## Platforms

macOS and Linux. On Windows, create an activation in the Konteks app and use
the install command it gives you.
