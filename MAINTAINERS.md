# Maintainers

The people who run this project and answer for it. Write to them about the code, a release, a licence
question or a collaboration. A security problem goes to the address below, through the private route in
[SECURITY.md](SECURITY.md): not to a personal address and not into a public issue.

| Name | Role | Email | GitHub |
| --- | --- | --- | --- |
| Eugene Riabchenko | Founder, lead maintainer | mothership@masia.to | masia-toots |
| Галюня | Co-founder | — | — |

`masia-toots` is the project's GitHub organisation, not a personal account. `—` means the person publishes no
contact. The playground suggests these people in its empty contacts list from `demo/contacts.json`; a test
keeps the two files equal, so when a contact changes, change both in one commit.

**Security reports:** security@masia.to, with `SECURITY` in the subject.

## What a maintainer does

- Reviews and merges changes, and cuts releases.
- Decides what goes into the protocol and the ports (`packages/contracts`), because every client and
  every relay depends on them.
- Keeps the licences straight: the relay is AGPL-3.0, everything else Apache-2.0 (see the `LICENSE`
  file in each package).

## Becoming a maintainer

Send useful changes, review other people's, and ask. A maintainer is added by the existing maintainers
in a commit to this file.
