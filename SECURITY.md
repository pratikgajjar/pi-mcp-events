# Security Policy

## Report a vulnerability

Do not open a public issue for a vulnerability. Report it privately:

- Use GitHub's "Report a vulnerability" button on the Security tab of this
  repository, or contact the maintainer through the
  [maintainer's GitHub profile](https://github.com/pratikgajjar).
- Include a description, the steps to reproduce, and the version or commit
  that you tested.

We reply within 72 hours. We try to ship a fix or a mitigation within 14 days.
We disclose the issue after the fix is released.

## Scope

pi-mcp-events runs inside pi with your permissions. These rules matter most:

- It starts only the stdio servers and connects only to the HTTP servers that
  your pi MCP configuration names. It reads a project `.pi/mcp.json` only when
  pi trusts the project.
- It sends event data to the model as untrusted input from the named server,
  never as an instruction from the user. A payload cannot close the wrapper
  that marks it.
- It does not open a port and does not receive webhooks.
- It writes only `mcp-events-state.json` (mode 0600) and `mcp-events.log` in
  the pi agent directory. The log has event ids, not payloads.

If you find a way to break one of these rules, it is in scope.
