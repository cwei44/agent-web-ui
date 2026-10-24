# Third-party components

This project provides a web interface for separately licensed command-line tools. Its own license does not replace their licenses.

| Component | Included here | Upstream information |
| --- | --- | --- |
| xterm.js and fit addon | Browser JavaScript/CSS in each UI directory | MIT; full notices in [codex/XTERM-LICENSE](codex/XTERM-LICENSE) and [claude/XTERM-LICENSE](claude/XTERM-LICENSE) |
| Codex CLI | Installed by the Codex Docker build | [OpenAI Codex source and license](https://github.com/openai/codex) |
| Claude Code and Claude Agent SDK | Installed during Docker builds | Copyright Anthropic PBC, all rights reserved; [Anthropic legal agreements](https://code.claude.com/docs/en/legal-and-compliance) |
| Node.js | Base container runtime | [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE) |
| node-pty | Installed as a Claude UI runtime dependency | [node-pty license](https://github.com/microsoft/node-pty/blob/main/LICENSE) |

Exact JavaScript dependency versions are recorded in each UI's package-lock.json. Other container packages retain their upstream license notices. No provider account credentials are part of this repository.
