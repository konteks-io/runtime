# Connect this machine to Konteks

Paste the block below into Claude Code or Codex, in a repository you care
about. Your agent will run two commands and then relay a few short questions.

```
Run these two commands and then follow the JSON the second one prints.

  curl -fsSL https://github.com/konteks-io/runtime/releases/latest/download/install.sh | sh -s -- --user --enroll
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
   repository with one empty first commit, and no file is added or changed.
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
- The Claude Code or Codex login you already have is what runs Konteks work on
  this machine. You are not asked to set up a provider.

## Platforms

macOS and Linux. On Windows, create an activation in the Konteks app and use
the install command it gives you.
